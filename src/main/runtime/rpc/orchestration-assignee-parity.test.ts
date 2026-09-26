/**
 * A coordinator runs one script against a terminal assignee and against a chat assignee, through
 * the real RPC dispatcher and methods, and every agent-visible result is diffed. The address is the
 * one allowed difference; the few fields that name which transport answered are listed below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import type * as WaitCap from '../orchestration/session-caller-wait-cap'
import {
  createSessionCallerHarness,
  idOf,
  isRecord,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  sessionRecord,
  WORKER_HANDLE,
  WORKER_PANE,
  WORKSPACE_X,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

/** A short shell-tool limit, so a start still settling returns inside it for both assignees. */
vi.mock('../orchestration/session-caller-wait-cap', async (importOriginal) => {
  const actual = await importOriginal<typeof WaitCap>()
  return {
    capSessionCallerWaitMs: (
      timeoutMs: number | undefined,
      caller: Parameters<typeof actual.capSessionCallerWaitMs>[1]
    ) =>
      caller ? Math.min(timeoutMs ?? 100, 100) : actual.capSessionCallerWaitMs(timeoutMs, caller)
  }
})

type Row = Record<string, unknown>
type Kind = 'terminal' | 'chat'

const SESSION_Z = testOrcaSessionId('3f9a1c7e-6b2d-4e85-a0c4-9d1e7b3f5a26')
const CHAT = formatOrcaSessionAddress(SESSION_Z)
const WORKER_INCARNATION = 'pty_worker:1'

/**
 * Fields that name which transport or evidence source answered, never what the agent is told to do:
 * worker-show's PTY summary (`terminal`), the PTY write receipt (`prompt`), and the fleet row's
 * evidence provenance (a PTY's hook status rows against a chat's session host).
 */
const TRANSPORT_FIELDS = new Set([
  'terminal',
  'prompt',
  'source',
  'evidence',
  'provider',
  // The PTY's own pane and process identity, which a chat has none of by design.
  'assigneePaneKey',
  'processIncarnation',
  'endpointIncarnation'
])

let h: SessionCallerHarness
let chatTurns: string[]
let assigneeBusy: boolean
let terminalPrompts: string[]
let releaseTerminal: () => void

function installHosts(): void {
  chatTurns = []
  assigneeBusy = false
  hostRef.current = {
    deps: {
      store: {
        getRecord: (id: string) => h.records.get(id) ?? null,
        listRecords: () => [...h.records.values()]
      }
    },
    hold: async () => {},
    release: () => {},
    hasSession: (id: string) => h.records.get(id)?.lease.claimStatus === 'live',
    close: async () => {},
    journalSnapshot: () => ({
      items: assigneeBusy
        ? [
            {
              itemId: 'running',
              revision: 1,
              observedAt: 1,
              sequence: 1,
              body: {
                kind: 'status',
                text: 'working',
                turnLifecycle: { turnId: 't', state: 'running' }
              }
            }
          ]
        : []
    }),
    history: () => ({ page: { items: [], hasOlder: false } }),
    send: async (_caller: unknown, input: { body: AgentJournalMessageItem }) => {
      chatTurns.push(input.body.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''))
      return {
        ok: true,
        value: {
          clientMessageId: `m${chatTurns.length}`,
          submission: { dispatchState: 'accepted' }
        }
      }
    }
  }
}

/** The PTY runtime surface a terminal worker is reached through; its readiness waits on release. */
function installTerminal(): void {
  terminalPrompts = []
  let ready: () => void = () => {}
  const readiness = new Promise<void>((resolve) => {
    ready = resolve
  })
  releaseTerminal = ready
  vi.spyOn(h.runtime, 'showTerminal').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker-start and worker-show read only these summary fields.
    { handle: WORKER_HANDLE, worktreeId: WORKSPACE_X, status: 'running' } as unknown as Awaited<
      ReturnType<typeof h.runtime.showTerminal>
    >
  )
  vi.spyOn(h.runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
  vi.spyOn(h.runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)
  vi.spyOn(h.runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle === WORKER_HANDLE ? WORKER_INCARNATION : null
  )
  vi.spyOn(h.runtime, 'getTerminalLivenessVerdict').mockReturnValue({ status: 'live' } as never)
  vi.spyOn(h.runtime, 'waitForTerminal').mockResolvedValue({
    handle: WORKER_HANDLE,
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  } as never)
  // The preamble is typed and queued behind the agent's running turn, which starts it on release.
  const prompt = {
    requestId: 'prompt_1',
    stages: [],
    provider: 'claude',
    observation: 'supported',
    processIncarnation: WORKER_INCARNATION,
    generation: 1,
    baselineWorkingSequence: 0
  } as const
  vi.spyOn(h.runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle, text) => {
    terminalPrompts.push(text)
    return { handle, accepted: true, bytesWritten: text.length, prompt: { ...prompt, stages: [] } }
  })
  vi.spyOn(h.runtime, 'observeTerminalAgentPrompt').mockImplementation(async () => {
    await readiness
    return { ...prompt, stages: ['turn_started'] }
  })
  // The hook status row a running terminal agent publishes; a chat has no pane to bind one to.
  vi.spyOn(h.runtime, 'getOrchestrationFleetAgentStatusSnapshot').mockImplementation(() => [
    {
      binding: {
        kind: 'pane',
        terminalHandle: WORKER_HANDLE,
        paneKey: WORKER_PANE,
        processIncarnation: WORKER_INCARNATION
      },
      clock: { kind: 'observed', at: Date.now() },
      deliveredAt: Date.now(),
      activity: {
        paneKey: WORKER_PANE,
        connectionId: null,
        // The same turn the chat twin is in: running until released, then between turns.
        state: assigneeBusy ? 'working' : 'done',
        agentType: 'claude',
        model: null,
        worktreeId: WORKSPACE_X,
        restoredUnconfirmed: false,
        providerSessionOnly: false
      }
    }
  ])
}

beforeEach(() => {
  h = createSessionCallerHarness(hostRef)
  h.records.set(SESSION_Z, sessionRecord(SESSION_Z))
  installHosts()
  installTerminal()
  vi.spyOn(h.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(h.runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement reads only the id of an existing workspace.
    { id: WORKSPACE_X, path: '/work/tree-x' } as Awaited<
      ReturnType<typeof h.runtime.showManagedTerminalWorkspace>
    >
  )
})

afterEach(() => {
  h.close()
  vi.restoreAllMocks()
})

async function call(sessionId: string | undefined, method: string, params: Row, cap?: string) {
  const request = orchestrationRequest(method, params, { sessionId })
  return resultOf(await h.dispatch(cap ? { ...request, orchestrationCapability: cap } : request))
}

/** How the worker names itself: a terminal by the handle its CLI sends, a chat by its session. */
function asWorker(kind: Kind, method: string, params: Row, cap?: string) {
  return kind === 'chat'
    ? call(SESSION_Z, method, params, cap)
    : call(
        undefined,
        method,
        { ...params, [method === 'orchestration.check' ? 'terminal' : 'from']: WORKER_HANDLE },
        cap
      )
}

/** The script, as a coordinator chat runs it against one assignee; every result it sees. */
async function runScript(kind: Kind): Promise<Row> {
  const address = kind === 'chat' ? CHAT : WORKER_HANDLE
  const seen: Row = {}
  await call(SESSION_X, 'orchestration.runCreate', { objective: 'parity' })
  const taskId = idOf((await call(SESSION_X, 'orchestration.taskCreate', { spec: 'work' })).task)

  // The assignee is mid-turn, so the preamble waits behind it: queued in a terminal's pane, owed to
  // a chat as its next turn.
  assigneeBusy = true
  const start = await call(SESSION_X, 'orchestration.workerStart', {
    task: taskId,
    terminal: address
  })
  const dispatchId = String(start.dispatchId)
  const shown = await call(SESSION_X, 'orchestration.workerShow', { dispatch: dispatchId })
  // The receipt says what worker-show says: one fact, one answer.
  expect(start.state, kind).toBe(isRecord(shown.worker) ? shown.worker.state : undefined)
  seen.start = start
  seen.showWhileStarting = shown
  seen.checkBeforeTask = await asWorker(kind, 'orchestration.check', {})

  assigneeBusy = false
  releaseTerminal()
  h.runtime.onStructuredSessionStatusForMail({ sessionId: SESSION_Z, status: 'idle' })
  await vi.waitFor(() => expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('ready'))
  const preamble = kind === 'chat' ? chatTurns.at(-1)! : terminalPrompts.at(-1)!
  const cap = /--dispatch-capability (\S+)/.exec(preamble)?.[1]
  seen.preamble = preamble

  for (const type of ['status', 'dispatch']) {
    await call(SESSION_X, 'orchestration.send', { to: address, type, subject: type, body: 'note' })
  }
  seen.check = await asWorker(kind, 'orchestration.check', {})
  seen.show = await call(SESSION_X, 'orchestration.workerShow', { dispatch: dispatchId })
  seen.list = await call(SESSION_X, 'orchestration.workerList', {})
  seen.done = await asWorker(
    kind,
    'orchestration.send',
    {
      type: 'worker_done',
      subject: 'done',
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
    },
    cap
  )
  seen.coordinatorCheck = await call(SESSION_X, 'orchestration.check', {})
  seen.stop = await call(SESSION_X, 'orchestration.workerStop', { dispatch: dispatchId })
  return seen
}

const ID =
  /\b(ctx|task|run|msg|delivery|wtr|thread)_[0-9a-z]+\b|dcap_[\w-]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g

/** The agent-visible JSON with the address and every minted id or clock made comparable. */
function normalize(value: unknown, address: string): unknown {
  if (typeof value === 'string') {
    return value.split(address).join('<address>').replace(ID, '<id>')
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, address))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !TRANSPORT_FIELDS.has(key))
        .map(([key, item]) => [
          key,
          /At$|_at$|^mutation$/.test(key) ? '<clock>' : normalize(item, address)
        ])
    )
  }
  return value
}

describe('a terminal assignee and a chat assignee, run through one coordinator script', () => {
  it('produce the same agent-visible results but for the address', async () => {
    const terminal = normalize(await runScript('terminal'), WORKER_HANDLE)
    h.close()
    vi.restoreAllMocks()
    h = createSessionCallerHarness(hostRef)
    h.records.set(SESSION_Z, sessionRecord(SESSION_Z))
    installHosts()
    installTerminal()
    vi.spyOn(h.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(h.runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement reads only the id of an existing workspace.
      { id: WORKSPACE_X, path: '/work/tree-x' } as Awaited<
        ReturnType<typeof h.runtime.showManagedTerminalWorkspace>
      >
    )
    const chat = normalize(await runScript('chat'), CHAT)

    expect(chat).toEqual(terminal)
  })
})
