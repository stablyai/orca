/**
 * A chat as a Dispatch assignee, through the real RPC dispatcher and methods: it is assigned by its
 * `session:<id>` address, handed the preamble as a turn, and runs the terminal worker's lifecycle
 * with the host-verified session as its proof of identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import type * as WaitCap from '../orchestration/session-caller-wait-cap'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import {
  ADDRESS_X,
  createSessionCallerHarness,
  idOf,
  isRecord,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  WORKSPACE_X,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

/** A shell-tool limit a test can shorten; otherwise the real per-provider one. */
const capRef = vi.hoisted((): { ms: number | undefined } => ({ ms: undefined }))
vi.mock('../orchestration/session-caller-wait-cap', async (importOriginal) => {
  const actual = await importOriginal<typeof WaitCap>()
  return {
    capSessionCallerWaitMs: (
      timeoutMs: number | undefined,
      caller: Parameters<typeof actual.capSessionCallerWaitMs>[1]
    ) =>
      capRef.ms !== undefined && caller
        ? Math.min(timeoutMs ?? capRef.ms, capRef.ms)
        : actual.capSessionCallerWaitMs(timeoutMs, caller)
  }
})

type Row = Record<string, unknown>

const SESSION_Z = testOrcaSessionId('3f9a1c7e-6b2d-4e85-a0c4-9d1e7b3f5a26')
const ADDRESS_Z = formatOrcaSessionAddress(SESSION_Z)
const SUCCESSOR_Z = testOrcaSessionId('clear-3f9a1c7e6b2d4e85a0c49d1e7b3f5a260000000a')

let h: SessionCallerHarness
/** Turns the chat host accepted, per session. */
let turns: { sessionId: string; text: string }[]
let busy: Set<string>
let closed: string[]

/** The session host a chat runs in: every session idle and live unless marked busy. */
function installChatHost(): void {
  turns = []
  busy = new Set()
  closed = []
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
    close: async (id: string) => {
      closed.push(id)
    },
    journalSnapshot: (id: string) => ({
      items: busy.has(id)
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
    history: ({ sessionId }: { sessionId: string }) => ({
      page: {
        items: [
          {
            itemId: `${sessionId}-1`,
            revision: 1,
            observedAt: 1,
            sequence: 1,
            body: {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: `work in ${sessionId}` }]
            }
          }
        ],
        hasOlder: false
      }
    }),
    send: async (
      _caller: unknown,
      input: { envelope: { sessionId: string }; body: AgentJournalMessageItem }
    ) => {
      const text = input.body.blocks.map((block) => (block.type === 'text' ? block.text : ''))
      turns.push({ sessionId: input.envelope.sessionId, text: text.join('') })
      return {
        ok: true,
        value: { clientMessageId: `m${turns.length}`, submission: { dispatchState: 'accepted' } }
      }
    }
  }
}

beforeEach(() => {
  capRef.ms = undefined
  h = createSessionCallerHarness(hostRef)
  h.records.set(SESSION_Z, sessionRecord(SESSION_Z))
  installChatHost()
})

afterEach(() => {
  h.close()
  vi.restoreAllMocks()
})

function call(sessionId: string | undefined, method: string, params: Row, capability?: string) {
  const request = orchestrationRequest(method, params, { sessionId })
  return h.dispatch(capability ? { ...request, orchestrationCapability: capability } : request)
}

async function as(
  sessionId: string | undefined,
  method: string,
  params: Row,
  capability?: string
): Promise<Row> {
  return resultOf(await call(sessionId, method, params, capability))
}

async function coordinatorTask(): Promise<{ runId: string; taskId: string }> {
  const runId = idOf((await as(SESSION_X, 'orchestration.runCreate', { objective: 'o' })).run)
  const taskId = idOf((await as(SESSION_X, 'orchestration.taskCreate', { spec: 'work' })).task)
  return { runId, taskId }
}

/** `dispatch --inject --to session:<chat>`, and the preamble it owes the chat. */
async function injectToChat(to = ADDRESS_Z) {
  const { runId, taskId } = await coordinatorTask()
  const result = await as(SESSION_X, 'orchestration.dispatch', {
    task: taskId,
    to,
    inject: true,
    returnPreamble: true
  })
  const dispatch = isRecord(result.dispatch) ? result.dispatch : {}
  const preamble = String(result.preamble)
  const capability = /--dispatch-capability (\S+)/.exec(preamble)?.[1] ?? ''
  return { runId, taskId, dispatchId: String(dispatch.id), preamble, capability, result }
}

function workerDone(taskId: string, dispatchId: string): Row {
  return {
    from: ADDRESS_Z,
    type: 'worker_done',
    subject: 'done',
    payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
  }
}

describe('dispatch --inject to a chat', () => {
  it('records the chat by its address and hands it the preamble as one turn', async () => {
    const { dispatchId, preamble, capability, result } = await injectToChat()

    expect(result).toMatchObject({ injected: true })
    expect(h.db.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: ADDRESS_Z,
      assignee_orca_session_id: SESSION_Z,
      assignee_pane_key: null,
      process_incarnation: null
    })
    expect(capability).toMatch(/^dcap_/)
    await vi.waitFor(() => expect(turns).toEqual([{ sessionId: SESSION_Z, text: preamble }]))
    // The turn is the preamble's reading: `check` never replays it.
    await vi.waitFor(() =>
      expect(h.db.getUnreadMessages(`dispatch:${dispatchId}`, undefined)).toEqual([])
    )
  })

  it('holds the preamble while the chat is mid-turn, and sends it at its idle edge', async () => {
    busy.add(SESSION_Z)
    const { dispatchId, preamble } = await injectToChat()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turns).toEqual([])

    busy.delete(SESSION_Z)
    h.runtime.onStructuredSessionStatusForMail({ sessionId: SESSION_Z, status: 'idle' })
    await vi.waitFor(() => expect(turns).toEqual([{ sessionId: SESSION_Z, text: preamble }]))
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it('never delivers the preamble of a Dispatch stopped before the chat could take it', async () => {
    busy.add(SESSION_Z)
    const { dispatchId } = await injectToChat()
    await as(SESSION_X, 'orchestration.workerStop', { dispatch: dispatchId })

    busy.delete(SESSION_Z)
    h.runtime.onStructuredSessionStatusForMail({ sessionId: SESSION_Z, status: 'idle' })
    h.runtime.deliverPendingMessagesForHandle(`dispatch:${dispatchId}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turns).toEqual([])
  })
})

describe('the chat runs the worker lifecycle as its own session', () => {
  it("settles the Dispatch with the chat's worker_done", async () => {
    const { taskId, dispatchId, capability } = await injectToChat()

    const sent = await as(
      SESSION_Z,
      'orchestration.send',
      workerDone(taskId, dispatchId),
      capability
    )

    expect(sent).toMatchObject({ lifecycle: { action: 'completed' } })
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('completed')
  })

  it("rejects another chat's worker_done, capability and all", async () => {
    const { taskId, dispatchId, capability } = await injectToChat()

    const sent = await as(
      SESSION_Y,
      'orchestration.send',
      { ...workerDone(taskId, dispatchId), from: undefined },
      capability
    )

    expect(sent).toMatchObject({ lifecycle: { action: 'rejected' } })
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it('reads its own Dispatch mailbox with a flagless check, as a terminal worker does', async () => {
    const { dispatchId } = await injectToChat()
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    const followUp = await as(SESSION_X, 'orchestration.send', {
      to: ADDRESS_Z,
      subject: 'also this'
    })
    expect(followUp).toMatchObject({ message: { to_handle: `dispatch:${dispatchId}` } })

    const checked = await as(SESSION_Z, 'orchestration.check', {})
    expect(checked).toMatchObject({ messages: [{ subject: 'also this' }] })
    expect(await as(SESSION_Y, 'orchestration.check', { peek: true })).not.toMatchObject({
      messages: [{ subject: 'also this' }]
    })
  })

  it('asks its coordinator through its Dispatch', async () => {
    const { runId, capability } = await injectToChat()
    const asked = await as(
      SESSION_Z,
      'orchestration.ask',
      { question: 'which way?', timeoutMs: 0 },
      capability
    )
    expect(asked).toMatchObject({ timedOut: true })
    expect(h.db.getQuestion(String(asked.messageId))).toMatchObject({ run_id: runId })
  })

  it('dispatches its own sub-worker one level deeper', async () => {
    vi.spyOn(h.runtime, 'getNestedWorkerMaxDepth').mockReturnValue(3)
    const { dispatchId } = await injectToChat()
    const parentDepth = h.db.getDispatchContextById(dispatchId)?.depth ?? 0
    await as(SESSION_Z, 'orchestration.runCreate', { objective: 'nested' })
    const sub = idOf((await as(SESSION_Z, 'orchestration.taskCreate', { spec: 'sub' })).task)

    const { dispatch } = await as(SESSION_Z, 'orchestration.dispatch', {
      task: sub,
      to: `session:${SESSION_Y}`
    })

    expect(dispatch).toMatchObject({ depth: parentDepth + 1 })
  })

  it('is still the assignee after /clear: its successor settles the Dispatch', async () => {
    const { taskId, dispatchId, capability } = await injectToChat()
    const cleared = sessionRecord(SESSION_Z, { lease: { claimStatus: 'released' } })
    h.records.set(SESSION_Z, {
      ...cleared,
      conversationCommand: {
        command: 'clear',
        runtimeFence: 7,
        operationId: 'op-clear',
        callerKey: 'surface',
        phase: 'committed',
        state: 'completed',
        replacementSessionId: SUCCESSOR_Z
      }
    })
    h.records.set(SUCCESSOR_Z, sessionRecord(SUCCESSOR_Z))

    const sent = await as(
      SUCCESSOR_Z,
      'orchestration.send',
      workerDone(taskId, dispatchId),
      capability
    )

    expect(sent).toMatchObject({ lifecycle: { action: 'completed' } })
    expect(h.db.getDispatchContextById(dispatchId)?.status).toBe('completed')
  })
})

describe('worker-start --terminal session:<chat>', () => {
  async function startOnChat(terminal = ADDRESS_Z) {
    const { runId, taskId } = await coordinatorTask()
    vi.spyOn(h.runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement reads only the id of an existing workspace.
      { id: WORKSPACE_X, path: '/work/tree-x' } as Awaited<
        ReturnType<typeof h.runtime.showManagedTerminalWorkspace>
      >
    )
    const response = await call(SESSION_X, 'orchestration.workerStart', {
      task: taskId,
      terminal,
      run: runId
    })
    return { runId, taskId, response }
  }

  it('starts the chat as a supervised worker the user keeps', async () => {
    const { taskId, response } = await startOnChat()
    const receipt = resultOf(response)
    const dispatchId = String(receipt.dispatchId)

    expect(receipt).toMatchObject({ state: 'ready', turnStart: 'observed' })
    expect(turns).toHaveLength(1)
    expect(turns[0]!.text).toContain(`Your orchestration address is: ${ADDRESS_Z}\n`)
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      terminal_handle: ADDRESS_Z,
      ownership_state: 'external',
      pane_key: null
    })

    const shown = await as(SESSION_X, 'orchestration.workerShow', { dispatch: dispatchId })
    expect(shown).toMatchObject({ observation: { status: 'live', exactWorker: true } })
    const read = await as(SESSION_X, 'orchestration.workerRead', { dispatch: dispatchId })
    expect(JSON.stringify(read)).toContain(`work in ${SESSION_Z}`)

    const stopped = await as(SESSION_X, 'orchestration.workerStop', { dispatch: dispatchId })
    expect(stopped).toMatchObject({ processAction: 'none' })
    expect(closed).toEqual([])
    void taskId
  })

  it('releases as retained, leaving the chat open', async () => {
    const { taskId, response } = await startOnChat()
    const dispatchId = String(resultOf(response).dispatchId)
    const capability = /--dispatch-capability (\S+)/.exec(turns[0]!.text)?.[1]
    await as(SESSION_Z, 'orchestration.send', workerDone(taskId, dispatchId), capability)

    const released = await as(SESSION_X, 'orchestration.workerRelease', { dispatch: dispatchId })

    expect(released).toMatchObject({ state: 'retained', processAction: 'none' })
    expect(closed).toEqual([])
  })

  it('refuses the coordinator itself', async () => {
    const { response } = await startOnChat(ADDRESS_X)
    expect(response).toMatchObject({ ok: false, error: { code: 'terminal_is_coordinator' } })
  })

  it('refuses a chat in another worktree', async () => {
    h.records.set(
      SESSION_Z,
      sessionRecord(SESSION_Z, { location: { workspaceId: 'repo_1::/elsewhere' } })
    )
    const { response } = await startOnChat()
    expect(response).toMatchObject({ ok: false, error: { code: 'terminal_worktree_mismatch' } })
  })

  it('makes the chat a member of its Run groups', async () => {
    const { response } = await startOnChat()
    const dispatchId = String(resultOf(response).dispatchId)

    for (const group of ['@all', '@claude', '@idle']) {
      const sent = await as(SESSION_X, 'orchestration.send', { to: group, subject: group })
      expect(sent, group).toMatchObject({
        messages: [expect.objectContaining({ to_handle: `dispatch:${dispatchId}` })]
      })
    }
    expect(
      await call(SESSION_X, 'orchestration.send', { to: '@codex', subject: 'x' })
    ).toMatchObject({ ok: false, error: { code: 'terminal_not_found' } })
  })
})

describe('worker-start from a chat caller', () => {
  it("returns the not-yet-ready receipt inside the caller's shell-tool limit, and keeps starting", async () => {
    capRef.ms = 50
    busy.add(SESSION_Z)
    const { runId, taskId } = await coordinatorTask()
    vi.spyOn(h.runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement reads only the id of an existing workspace.
      { id: WORKSPACE_X, path: '/work/tree-x' } as Awaited<
        ReturnType<typeof h.runtime.showManagedTerminalWorkspace>
      >
    )

    const receipt = await as(SESSION_X, 'orchestration.workerStart', {
      task: taskId,
      terminal: ADDRESS_Z,
      run: runId
    })

    const dispatchId = String(receipt.dispatchId)
    expect(receipt).toMatchObject({
      state: 'outcome_unknown',
      nextCommands: [
        `orca orchestration worker-show --dispatch ${dispatchId} --json`,
        `orca orchestration worker-abandon --dispatch ${dispatchId} --json`
      ]
    })
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('starting')

    busy.delete(SESSION_Z)
    h.runtime.onStructuredSessionStatusForMail({ sessionId: SESSION_Z, status: 'idle' })
    await vi.waitFor(() => expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('ready'), {
      timeout: 5_000
    })
  })
})

describe('reading a chat by its address', () => {
  it('serves terminal read from its journal', async () => {
    const read = await h.runtime.readTerminal(ADDRESS_Z)
    expect(read).toMatchObject({ handle: ADDRESS_Z, nextCursor: null })
    expect(read.tail.join('\n')).toContain(`work in ${SESSION_Z}`)
  })
})
