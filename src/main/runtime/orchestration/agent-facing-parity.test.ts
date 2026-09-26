/**
 * A chat agent and a terminal agent run the same orchestration process: the same preamble, the
 * same pointer text and the same guide. The one difference is the address string, which the agent
 * treats as opaque. Orca absorbs everything else host-side.
 */
import { readFileSync } from 'node:fs'
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

const sent = vi.hoisted((): { preambles: string[] } => ({ preambles: [] }))
vi.mock('../rpc/methods/orchestration-structured-worker-session', () => ({
  sendStructuredWorkerPreamble: async (args: { preamble: string }) => {
    sent.preambles.push(args.preamble)
  }
}))

const CHAT_SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const CHAT_ADDRESS = `session:${CHAT_SESSION}`
const TERMINAL_HANDLE = 'term_worker'
// `skill-guides/orchestration.md` on main before chats could orchestrate.
const MAIN_KERNEL_LINES = 197

const db = new OrchestrationDb(':memory:')
const RUN_ID = db.createRun({
  objective: 'parity',
  coordinatorHandle: 'term_coord',
  coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
}).id
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

/** A structured worker Orca started, an existing chat assigned by address, or a terminal. */
async function renderPreamble(worker: 'chat' | 'chat assignee' | 'terminal'): Promise<string> {
  const prompts: string[] = []
  const delivery = await deliverWorkerDispatchPreamble({
    runtime: runtime(prompts),
    db,
    structuredSession: worker === 'chat' ? structuredSession() : null,
    terminalHandle:
      worker === 'chat'
        ? 'structworker_1'
        : worker === 'chat assignee'
          ? CHAT_ADDRESS
          : TERMINAL_HANDLE,
    dispatchId: 'ctx_1',
    dispatchDepth: 1,
    taskId: 'task_1',
    taskSpec: 'do it',
    coordinatorHandle: 'term_coord',
    dispatchCapability: 'cap',
    devMode: false,
    requestId: 'req_1',
    runId: RUN_ID
  })
  if (delivery.preambleTurnMessageId) {
    return db.getMessageById(delivery.preambleTurnMessageId)!.body
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
      readGateFacts: () => ({ turnRunning: false, awaitingHuman: false }),
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

describe('a chat agent and a terminal agent see the same text but for the address', () => {
  it('renders one worker preamble', async () => {
    const chat = await renderPreamble('chat')
    const terminal = await renderPreamble('terminal')

    expect(chat).toContain(`Your orchestration address is: ${CHAT_ADDRESS}\n`)
    expect(chat.split(CHAT_ADDRESS).join('<address>')).toBe(
      terminal.split(TERMINAL_HANDLE).join('<address>')
    )
  })

  it('renders one worker preamble for an existing chat dispatched to by its address', async () => {
    const assignee = await renderPreamble('chat assignee')
    const terminal = await renderPreamble('terminal')

    expect(assignee).toContain(`Your orchestration address is: ${CHAT_ADDRESS}\n`)
    expect(assignee.split(CHAT_ADDRESS).join('<address>')).toBe(
      terminal.split(TERMINAL_HANDLE).join('<address>')
    )
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

  it('has no chat-only section and is no longer than it was before chats orchestrated', () => {
    expect(kernel.split('\n').length - 1).toBeLessThanOrEqual(MAIN_KERNEL_LINES)
    expect(kernel).not.toMatch(/chat|session:<id>|ORCA_CLI_COMMAND|\/clear|end your turn/i)
    expect(kernel).toContain('`ORCA status --json` shows your own orchestration address')
  })
})
