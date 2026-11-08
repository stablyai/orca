import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AgentHookServer } from '../../../../../agent-hooks/server'
import type { AgentStatusState } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  COORDINATOR_PANE_KEY,
  createOrchestrationRpcHarness,
  type OrchestrationRpcState
} from '../rpc-test-harness'

const WORKTREE = 'repo-1::/tmp/a'
const PANES = {
  term_worker: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  term_other: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
} as const
type Worker = keyof typeof PANES

const EventsResult = z.object({
  cursor: z.string(),
  events: z.array(
    z.object({
      type: z.string(),
      reason: z.string().optional(),
      cursor: z.string().optional(),
      message: z.object({ subject: z.string() }).optional()
    })
  )
})

const StateEvents = z.object({
  cursor: z.string(),
  events: z.array(z.object({ type: z.string() }).passthrough())
})

/** Feeds hook rows through the runtime's real transition detector, as the hook server does. */
function attachWorkers({ db, runtime }: OrchestrationRpcState) {
  const panes: Record<string, string> = { term_coord: COORDINATOR_PANE_KEY, ...PANES }
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) => panes[handle] ?? null)
  const handles = new Map<string, string>(
    Object.entries(PANES).map(([handle, pane]) => [pane, handle])
  )
  vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockImplementation(
    (paneKey) => handles.get(paneKey) ?? null
  )
  const server = new AgentHookServer()
  runtime.agentTransitions.attach(server)
  return {
    hook: (worker: Worker, state: AgentStatusState, toolName?: string) =>
      server.ingestTerminalStatus({
        paneKey: PANES[worker],
        tabId: PANES[worker].split(':')[0],
        worktreeId: WORKTREE,
        payload: { state, prompt: 'task', agentType: 'codex', ...(toolName ? { toolName } : {}) }
      }),
    dispatch: (worker: Worker) => {
      const task = db.createTask({ spec: `task for ${worker}` })
      const dispatch = db.createDispatchContext({
        taskId: task.id,
        assigneeHandle: worker,
        assigneePaneKey: PANES[worker],
        creator: { kind: 'system' },
        maxDepth: 9
      })
      return { dispatchId: dispatch.id, taskId: task.id }
    }
  }
}

describe('orchestration.events', () => {
  const h = createOrchestrationRpcHarness()

  afterEach(() => {
    h.cleanup()
  })

  it('announces Run mail without taking the pointer delivery from the coordinator', async () => {
    const { db, runtime, ctx, activeRunId } = h.setup()
    const deliver = vi
      .spyOn(runtime, 'deliverPendingMessagesForHandle')
      .mockImplementation(() => {})
    const start = EventsResult.parse(
      await h.call('orchestration.events', { runId: activeRunId, terminal: 'term_coord' }, ctx)
    )
    const polling = h.call(
      'orchestration.events',
      { runId: activeRunId, terminal: 'term_coord', sinceCursor: start.cursor, timeoutMs: 5000 },
      ctx
    )

    db.insertMessage({ from: 'term_worker', to: `run:${activeRunId}`, subject: 'Ready for review' })
    runtime.notifyMessageArrived(`run:${activeRunId}`, 'status')

    await expect(polling).resolves.toMatchObject({
      events: [{ type: 'message', message: { subject: 'Ready for review' } }]
    })
    await vi.waitFor(() =>
      expect(deliver).toHaveBeenCalledWith(`run:${activeRunId}`, expect.any(Set))
    )
  })

  it('resumes after a message cursor and reports a cursor from another database as lost', async () => {
    const { db, ctx, activeRunId } = h.setup()
    const call = async (sinceCursor?: string) =>
      EventsResult.parse(
        await h.call(
          'orchestration.events',
          { runId: activeRunId, terminal: 'term_coord', sinceCursor, timeoutMs: 50 },
          ctx
        )
      )
    const start = await call()
    db.insertMessage({ from: 'term_worker', to: `run:${activeRunId}`, subject: 'First' })
    db.insertMessage({ from: 'term_worker', to: `run:${activeRunId}`, subject: 'Second' })

    const both = await call(start.cursor)
    expect(both.events.map((event) => event.message?.subject)).toEqual(['First', 'Second'])
    const resumed = await call(both.events[0].cursor)
    expect(resumed.events.map((event) => event.message?.subject)).toEqual(['Second'])
    expect((await call('999999.other.0')).events).toEqual([
      { type: 'lost', reason: 'cursor_unknown' }
    ])
  })

  async function poll(
    ctx: OrchestrationRpcState['ctx'],
    runId: string,
    terminal: string,
    sinceCursor?: string
  ) {
    return StateEvents.parse(
      await h.call('orchestration.events', { runId, terminal, sinceCursor, timeoutMs: 50 }, ctx)
    )
  }

  it('sends one worker_state per hook state change of a Dispatch pane', async () => {
    const state = h.setup()
    const runId = state.activeRunId!
    const workers = attachWorkers(state)
    const worker = workers.dispatch('term_worker')
    const start = await poll(state.ctx, runId, 'term_coord')

    workers.hook('term_worker', 'working', 'Bash')
    // A tool-only update keeps the state, so it is not an event.
    workers.hook('term_worker', 'working', 'Edit')
    const changed = await poll(state.ctx, runId, 'term_coord', start.cursor)
    expect(changed.events).toEqual([
      {
        type: 'worker_state',
        runId,
        ...worker,
        state: 'working',
        since: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        lastTool: 'Bash',
        cursor: expect.any(String)
      }
    ])
    expect((await poll(state.ctx, runId, 'term_coord', changed.cursor)).events).toEqual([])
  })

  it('shows a worker only its own Dispatch state and none of the Run mail', async () => {
    const state = h.setup()
    const runId = state.activeRunId!
    const workers = attachWorkers(state)
    const own = workers.dispatch('term_worker')
    workers.dispatch('term_other')
    const start = await poll(state.ctx, runId, 'term_worker')

    workers.hook('term_other', 'working')
    workers.hook('term_worker', 'blocked')
    state.db.insertMessage({ from: 'term_other', to: `run:${runId}`, subject: 'Coordinator only' })
    const seen = await poll(state.ctx, runId, 'term_worker', start.cursor)
    expect(seen.events).toEqual([
      expect.objectContaining({ type: 'worker_state', ...own, state: 'blocked' })
    ])
  })

  it('sends a state seen before its Dispatch bound the pane once the binding lands', async () => {
    const state = h.setup()
    const runId = state.activeRunId!
    const workers = attachWorkers(state)
    const start = await poll(state.ctx, runId, 'term_coord')

    workers.hook('term_worker', 'working', 'Bash')
    const worker = workers.dispatch('term_worker')
    workers.hook('term_worker', 'working', 'Edit')
    expect((await poll(state.ctx, runId, 'term_coord', start.cursor)).events).toEqual([
      expect.objectContaining({
        type: 'worker_state',
        ...worker,
        state: 'working',
        lastTool: 'Edit'
      })
    ])
  })

  it('ends a worker poll whose Dispatch closed without waking it', async () => {
    const state = h.setup()
    const runId = state.activeRunId!
    const workers = attachWorkers(state)
    const { dispatchId } = workers.dispatch('term_worker')
    const start = await poll(state.ctx, runId, 'term_worker')

    const polling = poll(state.ctx, runId, 'term_worker', start.cursor)
    state.db.completeDispatch(dispatchId)
    expect((await polling).events).toEqual([{ type: 'end', reason: 'dispatch_closed' }])
  })
})
