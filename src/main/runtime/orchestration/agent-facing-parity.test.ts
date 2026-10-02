/**
 * A chat agent and a terminal agent run the same orchestration process: the same preamble, the
 * same pointer text and the same guide. The one difference is how each is named: a terminal by its
 * handle, exactly as on main, and a session by its Orca session ID. Orca absorbs everything else.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../../shared/app-environment'
import type { OrcaRuntimeService } from '../orca-runtime'
import { deliverWorkerDispatchPreamble } from '../rpc/methods/orchestration/worker/deliver-worker-dispatch-preamble'
import { decideWorkerStartMode } from '../rpc/methods/orchestration-worker-start-mode'
import {
  localOrchestrationCliCommand,
  resolveTerminalOrchestrationCliCommand,
  runtimeOrchestrationCliCommand,
  type OrchestrationCliCommand
} from './cli-command'
import { OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'
import { buildDispatchPreamble } from './preamble'
import { ORCA_SESSION_ID_AS_ADDRESS } from '../../../shared/orca-session-id-wording-test-fixture'

const sent = vi.hoisted((): { preambles: string[] } => ({ preambles: [] }))
vi.mock('../rpc/methods/orchestration-structured-worker-session', () => ({
  sendStructuredWorkerPreamble: async (args: { preamble: string }) => {
    sent.preambles.push(args.preamble)
  }
}))

const CHAT_SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const CHAT_ADDRESS = `orca_session_id:${CHAT_SESSION}`
const TERMINAL_HANDLE = 'term_worker'
// A structured worker's mailbox key: the handle it was minted, which its preamble never shows.
const CHAT_WORKER_HANDLE = 'structworker_1'
// `skill-guides/orchestration.md` on main, plus the one Orca session ID line.
const MAIN_KERNEL_LINES = 198 + 1

const db = new OrchestrationDb(':memory:')
const SELF_LINE = `\nYour Orca session ID is: ${CHAT_ADDRESS}`
const previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null

afterEach(() => {
  sent.preambles = []
  if (previousEnvironment) {
    setAppEnvironment(previousEnvironment)
  }
})

afterAll(() => {
  db.close()
})

function installApp(isPackaged: boolean): void {
  setAppEnvironment({
    getPath: () => '/tmp/orca-parity',
    getAppPath: () => '/tmp/orca-parity',
    getVersion: () => '0.0.0-test',
    isPackaged: () => isPackaged,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  } satisfies AppEnvironment)
}

function runtime(prompts: string[]): OrcaRuntimeService {
  const fake: Pick<
    OrcaRuntimeService,
    | 'getNestedWorkerMaxDepth'
    | 'getTerminalOrchestrationCliCommand'
    | 'sendTerminalAgentPrompt'
    | 'deliverPendingMessagesForHandle'
  > = {
    deliverPendingMessagesForHandle: () => {},
    getNestedWorkerMaxDepth: () => 2,
    getTerminalOrchestrationCliCommand: () => 'orca',
    sendTerminalAgentPrompt: async (handle, text) => {
      prompts.push(text)
      return { handle, accepted: true, bytesWritten: text.length }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preamble delivery reads only the members the fake implements.
  return fake as OrcaRuntimeService
}

type StructuredSession = Parameters<typeof deliverWorkerDispatchPreamble>[0]['structuredSession']

function structuredSession(): StructuredSession {
  const session = { host: {}, identity: { sessionId: CHAT_SESSION, agent: 'codex' } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery reads only identity.sessionId, and the mocked send ignores host.
  return session as unknown as StructuredSession
}

/** A structured worker Orca started, an existing chat assigned by its Orca session ID, or a terminal. */
async function renderPreamble(worker: 'chat' | 'chat assignee' | 'terminal'): Promise<string> {
  const prompts: string[] = []
  const delivery = await deliverWorkerDispatchPreamble({
    runtime: runtime(prompts),
    db,
    structuredSession: worker === 'chat' ? structuredSession() : null,
    terminalHandle:
      worker === 'chat'
        ? CHAT_WORKER_HANDLE
        : worker === 'chat assignee'
          ? CHAT_ADDRESS
          : TERMINAL_HANDLE,
    dispatchId: 'ctx_1',
    dispatchDepth: 1,
    taskId: 'task_1',
    taskSpec: 'do it',
    coordinatorHandle: 'term_coord',
    devMode: false,
    requestId: 'req_1'
  })
  if (delivery.chatPreambleTurn) {
    return db.getDispatchPreambleTurn('ctx_1')!.body
  }
  return worker === 'chat' ? sent.preambles[0]! : prompts[0]!
}

/** The turn text the structured lane sends a chat for one message on `mailbox`. */
async function renderChatPointer(mailbox: string): Promise<string> {
  const texts: string[] = []
  db.insertMessage({ from: 'term_peer', to: mailbox, subject: 'hi' })
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: CHAT_SESSION, dispatchId: null }),
    // The runtime's wiring of the structured lane.
    getCliCommand: localOrchestrationCliCommand,
    host: {
      readGateFacts: async () => ({ turnRunning: false, awaitingHuman: false, submissions: [] }),
      currentFence: () => 1,
      send: async (input) => {
        for (const block of input.body.blocks) {
          texts.push(block.type === 'text' ? block.text : '')
        }
        return { kind: 'sent', state: 'accepted' }
      }
    }
  })
  delivery.deliverForHandle(mailbox)
  await vi.waitFor(() => expect(texts).toHaveLength(1))
  return texts[0]!
}

describe('a chat agent and a terminal agent see the same text but for how each is named', () => {
  it("teaches a chat worker a terminal worker's preamble but for its identity lines", async () => {
    const chat = await renderPreamble('chat')
    const terminal = await renderPreamble('terminal')

    expect(terminal).not.toContain('Orca session ID')
    expect(chat).toContain(`Your task ID is: task_1${SELF_LINE}\n`)
    expect(chat).not.toContain(CHAT_WORKER_HANDLE)
    expect(chat.replace(SELF_LINE, '').split(CHAT_ADDRESS).join(TERMINAL_HANDLE)).toBe(terminal)
  })

  it('renders an existing chat dispatched to by its Orca session ID the preamble a started chat gets', async () => {
    const assignee = await renderPreamble('chat assignee')
    const terminal = await renderPreamble('terminal')

    expect(assignee).toBe(await renderPreamble('chat'))
    expect(assignee.replace(SELF_LINE, '').split(CHAT_ADDRESS).join(TERMINAL_HANDLE)).toBe(terminal)
  })

  it.each([
    ['a packaged app', true],
    ['a dev build', false]
  ])(
    'renders the pointer the PTY lane types into a local terminal, in %s',
    async (_label, packaged) => {
      installApp(packaged)
      // What the PTY lane types for a local, non-WSL terminal (`getTerminalOrchestrationCliCommand`).
      const terminalCli: OrchestrationCliCommand = resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::/tmp/wt',
        runtimeCliCommand: runtimeOrchestrationCliCommand()
      })
      expect(terminalCli).toBe(packaged ? 'orca' : 'orca-dev')

      for (const mailbox of ['run:run_parity', CHAT_ADDRESS]) {
        expect(await renderChatPointer(mailbox)).toBe(
          formatMessagePointer(1, mailbox, terminalCli).trim()
        )
      }
    }
  )
})

describe('the worker-start receipt for a reused agent', () => {
  it.each([
    [
      'a structured default',
      {
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: true,
        openAgentTabsInChatByDefault: true
      }
    ],
    ['a terminal default', {}]
  ])('names neither kind, whichever the address is, under %s', (_label, settings) => {
    const chat = decideWorkerStartMode({ params: { terminal: CHAT_ADDRESS }, settings })
    const terminal = decideWorkerStartMode({ params: { terminal: TERMINAL_HANDLE }, settings })

    expect(chat).toEqual(terminal)
    expect(chat.mode).toBe('reused')
    expect(chat.detail).not.toMatch(/terminal agent|chat|structured/i)
  })
})

describe('the orchestration guide an agent loads', () => {
  const kernel = readFileSync(join(process.cwd(), 'skill-guides', 'orchestration.md'), 'utf8')

  it('has no chat-only section and grows only by the Orca session ID line', () => {
    expect(kernel.split('\n').length - 1).toBeLessThanOrEqual(MAIN_KERNEL_LINES)
    expect(kernel).not.toMatch(/chat|session:<id>|ORCA_CLI_COMMAND|\/clear|end your turn/i)
    expect(kernel).toContain(
      '`ORCA status --json` shows your Orca session ID as `caller.orcaSessionId` when you have one.'
    )
  })
})

describe('agent-read text about an Orca session ID', () => {
  // CLI help, specs and status text: src/cli/orca-session-id-wording.test.ts.
  const guideDir = join(process.cwd(), 'skill-guides')
  const guide = [
    join(guideDir, 'orchestration.md'),
    ...readdirSync(join(guideDir, 'orchestration', 'references')).map((name) =>
      join(guideDir, 'orchestration', 'references', name)
    )
  ]
  // Refusals an agent reads: the string literals of the files that word them.
  const refusalSources = [
    'orchestration/orchestration-party.ts',
    'rpc/orchestration-session-caller.ts',
    'rpc/methods/orchestration/messaging/session-recipient.ts',
    'rpc/methods/orchestration/caller-show.ts'
  ].flatMap(
    (file) =>
      readFileSync(join(process.cwd(), 'src', 'main', 'runtime', file), 'utf8').match(
        /'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g
      ) ?? []
  )

  it.each([
    ['the guide and its references', () => guide.map((file) => readFileSync(file, 'utf8'))],
    [
      'the preamble, for every pairing of kinds',
      () =>
        [CHAT_ADDRESS, 'term_coord'].flatMap((coordinatorHandle) =>
          [CHAT_ADDRESS, TERMINAL_HANDLE].map((workerHandle) =>
            buildDispatchPreamble({
              taskId: 'task_1',
              dispatchId: 'ctx_1',
              taskSpec: 'do it',
              coordinatorHandle,
              workerHandle
            })
          )
        )
    ],
    ['the refusals that name a session', () => refusalSources]
  ])('never calls it an address in %s', (_where, texts) => {
    for (const text of texts()) {
      expect(text).not.toMatch(ORCA_SESSION_ID_AS_ADDRESS)
    }
  })
})
