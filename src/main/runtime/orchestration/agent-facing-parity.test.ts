/** Chat and terminal agents must receive equivalent preambles and pointers, apart from address and chat wording. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../../shared/app-environment'
import type { OrcaRuntimeService } from '../orca-runtime'
import { deliverWorkerDispatchPreamble } from '../rpc/methods/orchestration/worker/deliver-worker-dispatch-preamble'
import {
  localOrchestrationCliCommand,
  resolveTerminalOrchestrationCliCommand,
  runtimeOrchestrationCliCommand,
  type OrchestrationCliCommand
} from './cli-command'
import { OrchestrationDb } from './db'
import { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'
import {
  CHAT_REDISPATCH_PARAGRAPH as CHAT_REDISPATCH,
  TERMINAL_REDISPATCH_PARAGRAPH as TERMINAL_REDISPATCH
} from './preamble'

const sent = vi.hoisted((): { preambles: string[] } => ({ preambles: [] }))
vi.mock('../rpc/methods/orchestration-structured-worker-session', () => ({
  sendStructuredWorkerPreamble: async (args: { preamble: string }) => {
    sent.preambles.push(args.preamble)
  }
}))

const CHAT_SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const CHAT_ADDRESS = `orca_session_id:${CHAT_SESSION}`
const TERMINAL_HANDLE = 'term_worker'
// The structured worker's hidden mailbox handle differs from its visible session address.
const CHAT_WORKER_HANDLE = 'structworker_1'

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
    'getNestedWorkerMaxDepth' | 'getTerminalOrchestrationCliCommand' | 'sendTerminalAgentPrompt'
  > & {
    orchestrationSenderNames: Pick<OrcaRuntimeService['orchestrationSenderNames'], 'snapshotOf'>
  } = {
    orchestrationSenderNames: { snapshotOf: () => ({ name: null, agent: null }) },
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

async function renderPreamble(worker: 'chat' | 'terminal'): Promise<string> {
  const prompts: string[] = []
  await deliverWorkerDispatchPreamble({
    runtime: runtime(prompts),
    db,
    structuredSession: worker === 'chat' ? structuredSession() : null,
    terminalHandle: worker === 'chat' ? CHAT_WORKER_HANDLE : TERMINAL_HANDLE,
    dispatchId: 'ctx_1',
    dispatchDepth: 1,
    runId: 'run_1',
    taskId: 'task_1',
    taskSpec: 'do it',
    coordinatorHandle: 'term_coord',
    devMode: false,
    requestId: 'req_1'
  })
  return worker === 'chat' ? sent.preambles[0]! : prompts[0]!
}

/** Render what the structured lane hands a chat for one mailbox message. */
async function renderChatMail(mailbox: string): Promise<{ text: string; id: string }> {
  const texts: string[] = []
  const message = db.insertMessage({ from: 'term_peer', to: mailbox, subject: 'hi' })
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: CHAT_SESSION, dispatchId: null }),
    getCliCommand: localOrchestrationCliCommand,
    senderSnapshot: () => ({ name: null, agent: null }),
    host: {
      currentFence: () => 1,
      observe: async () => 'handed',
      repeatable: async () => false,
      withdraw: async () => true,
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
  return { text: texts[0]!, id: message.id }
}

describe('a chat agent and a terminal agent see the same text but for how each is named and called', () => {
  it("teaches a chat worker a terminal worker's preamble but for its identity lines and the chat wording", async () => {
    const chat = await renderPreamble('chat')
    const terminal = await renderPreamble('terminal')
    const withoutRedispatch = chat.replace(CHAT_REDISPATCH, TERMINAL_REDISPATCH)

    expect(terminal).not.toContain('Orca session ID')
    expect(chat).toContain(`Your task ID is: task_1${SELF_LINE}\n`)
    expect(chat).not.toContain(CHAT_WORKER_HANDLE)
    expect(chat).not.toContain('this terminal')
    expect(withoutRedispatch).not.toBe(chat)
    expect(withoutRedispatch.split('this chat')).toHaveLength(3)
    expect(
      withoutRedispatch
        .replace(SELF_LINE, '')
        .split(CHAT_ADDRESS)
        .join(TERMINAL_HANDLE)
        .split('this chat')
        .join('this terminal')
    ).toBe(terminal)
  })

  it.each([
    ['a packaged app', true],
    ['a dev build', false]
  ])(
    'names the CLI the PTY lane types into a local terminal in a chat message, in %s',
    async (_label, packaged) => {
      installApp(packaged)
      const terminalCli: OrchestrationCliCommand = resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::/tmp/wt',
        runtimeCliCommand: runtimeOrchestrationCliCommand()
      })
      expect(terminalCli).toBe(packaged ? 'orca' : 'orca-dev')

      for (const mailbox of ['run:run_parity', CHAT_ADDRESS]) {
        const { text, id } = await renderChatMail(mailbox)
        expect(text).toContain(`[Reply: ${terminalCli} orchestration reply --id ${id}`)
      }
    }
  )
})
