import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { HeadlessEmulator } from '../../../../daemon/emulation/headless-emulator'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import {
  createRuntime,
  createBoundRun,
  insertDirectRunMessage,
  PTY_ID,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { checkBoundMailbox } from './orchestration-mailbox-check.test-fixture'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const binary = process.env.ORCA_REPRO_CODEX_BINARY
const evidence = process.env.ORCA_REPRO_EVIDENCE_DIR
const notice = `You have 1 orchestration message. Run \`orca orchestration check --terminal ${TERMINAL_HANDLE}\`.`
// ast-grep-ignore: test-no-real-time-wait -- Real ConPTY and Codex cannot use Vitest's fake clock.
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const cases = [
  { name: 'idle', draft: '', working: false, holdFirstEnter: false },
  { name: 'working', draft: '', working: true, holdFirstEnter: false },
  { name: 'held-enter', draft: '', working: false, holdFirstEnter: true },
  { name: 'user-draft', draft: 'My unsent design notes', working: false, holdFirstEnter: false },
  { name: 'old-notice', draft: notice, working: false, holdFirstEnter: false },
  {
    name: 'duplicate-notice',
    draft: `${notice}\n\n${notice}`,
    working: false,
    holdFirstEnter: false
  }
]

it.skipIf(!binary || !evidence || process.platform !== 'win32').each(cases)(
  'protects Windows Codex input and delivers once: $name',
  async ({ name, draft, working, holdFirstEnter }) => {
    const directory = join(evidence!, name)
    const workspace = join(directory, 'work')
    mkdirSync(workspace, { recursive: true })
    const db = new OrchestrationDb(':memory:')
    const { runtime } = await createRuntime(db)
    const run = createBoundRun(db, `Windows Codex ${name}`)
    const trace: unknown[] = []
    let raw = ''
    let requests = 0
    let notices = 0
    let firstCompleted = false
    let message: ReturnType<typeof insertDirectRunMessage> | undefined
    const arrive = () => {
      message = insertDirectRunMessage(db, run.id, 'Isolated reply body')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    }
    const model = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      let body = ''
      for await (const chunk of req) {
        body += chunk
      }
      const notification = body.includes('You have 1 orchestration message')
      const id = `response-${++requests}`
      if (notification) {
        notices++
      }
      trace.push({ event: 'request', id, notification })
      runtime.ingestSyntheticTitleFrame(PTY_ID, '\x1b]0;Codex working\x07')
      if (requests === 1 && working) {
        arrive()
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // ast-grep-ignore: test-no-real-time-wait -- Keep the real Codex request active while its mailbox is notified.
      await delay(working && requests === 1 ? 2500 : 400)
      for (const event of [
        { type: 'response.created', response: { id } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            id: `msg-${id}`,
            content: [{ type: 'output_text', text: 'Fixture finished.' }]
          }
        },
        {
          type: 'response.completed',
          response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
        }
      ]) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.end()
      firstCompleted = true
      runtime.ingestSyntheticTitleFrame(PTY_ID, '\x1b]0;Codex done\x07')
    })
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    const address = model.address()
    if (!address || typeof address === 'string') {
      throw new Error('No fixture port')
    }
    writeFileSync(
      join(directory, 'config.toml'),
      [
        'model="gpt-6-astra"',
        'model_reasoning_effort="high"',
        'model_provider="fixture"',
        'check_for_update_on_startup=false',
        '[model_providers.fixture]',
        'name="fixture"',
        `base_url="http://127.0.0.1:${address.port}/v1"`,
        'wire_api="responses"',
        'requires_openai_auth=false',
        '[tui]',
        'terminal_title=["spinner","project-name"]',
        `[projects.${JSON.stringify(workspace)}]`,
        'trust_level="trusted"'
      ].join('\n')
    )
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(ORCA_|CODEX_|OPENAI_|ANTHROPIC_)/.test(key)) {
        env[key] = value
      }
    }
    const terminal = pty.spawn(binary!, ['--no-alt-screen', 'Reply OK only'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: workspace,
      env: { ...env, CODEX_HOME: directory, TERM: 'xterm-256color', ORCA_BACKGROUND_LAUNCH: '1' }
    })
    let exited = false
    terminal.onExit((event) => {
      runtime.onPtyExit(PTY_ID, event.exitCode)
      exited = true
    })
    let enters = 0
    const writes: string[] = []
    const write = (_id: string, data: string) => {
      writes.push(data)
      if (data === '\r' && ++enters === 1 && holdFirstEnter) {
        return true
      }
      terminal.write(data)
      return true
    }
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      getSize: () => ({ cols: 120, rows: 40 }),
      kill: () => {
        terminal.kill()
        return true
      },
      getForegroundProcess: async () => 'codex'
    })
    let seq = 0
    const display = new HeadlessEmulator({
      cols: 120,
      rows: 40,
      onQueryReply: (reply) => terminal.write(reply)
    })
    terminal.onData((data) => {
      raw += data
      void display.write(data, { forwardQueryReplies: true })
      runtime.onPtyData(PTY_ID, data, ++seq)
    })
    try {
      await runtime.listTerminals()
      await vi.waitFor(() => expect(firstCompleted).toBe(true), { timeout: 60000 })
      await vi.waitFor(
        async () => {
          const screen = await runtime.readTerminal(TERMINAL_HANDLE, { screen: true })
          expect(screen.tail.some((line) => line.includes('Worked for'))).toBe(true)
        },
        { timeout: 15000 }
      )
      if (draft) {
        terminal.write(`\x1b[200~${draft}\x1b[201~`)
        await vi.waitFor(
          () => expect(runtime.readTerminalMailHold(TERMINAL_HANDLE)).toEqual({ kind: 'draft' }),
          { timeout: 15000 }
        )
      }
      if (!working) {
        arrive()
      }
      if (draft) {
        // ast-grep-ignore: test-no-real-time-wait -- Observe absence of writes across real notification retry timers.
        await delay(6000)
        runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
        // ast-grep-ignore: test-no-real-time-wait -- A repeated delivery signal must remain silent on the live PTY.
        await delay(1500)
        expect(writes).toEqual([])
        expect(notices).toBe(0)
        expect(db.getMessageById(message!.id)?.read).toBe(0)
        expect(runtime.readTerminalMailHold(TERMINAL_HANDLE)).toEqual({ kind: 'draft' })
        expect((await runtime.readTerminal(TERMINAL_HANDLE, { screen: true })).draft).toBe(draft)
      } else {
        await vi.waitFor(() => expect(notices).toBe(1), { timeout: 20000 })
        runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        // ast-grep-ignore: test-no-real-time-wait -- Catch delayed duplicate input after the real Codex accepted the notice.
        await delay(2500)
        expect(notices).toBe(1)
        expect(enters).toBe(holdFirstEnter ? 2 : 1)
        expect(writes.filter((data) => data.includes('orchestration check'))).toHaveLength(1)
        const checked = await checkBoundMailbox(runtime)
        expect(checked.count).toBe(1)
        await checkBoundMailbox(runtime, { ack: checked.deliveryId! })
        expect(await checkBoundMailbox(runtime)).toMatchObject({ count: 0, messages: [] })
      }
    } finally {
      trace.push({
        event: 'terminal-read',
        terminal: await runtime.readTerminal(TERMINAL_HANDLE, { screen: true })
      })
      trace.push({
        name,
        requests,
        notices,
        enters,
        writes,
        exited,
        message: message && db.getMessageById(message.id)
      })
      writeFileSync(join(directory, 'trace.json'), JSON.stringify(trace, null, 2))
      writeFileSync(join(directory, 'terminal.bin'), raw)
      if (!exited) {
        terminal.kill()
      }
      display.dispose()
      await vi.waitFor(() => expect(exited).toBe(true), { timeout: 5000 })
      model.closeAllConnections()
      await new Promise<void>((resolve) => model.close(() => resolve()))
      db.close()
    }
  },
  120000
)
