import { describe, expect, it } from 'vitest'
import { createAgentChildWorkAdmission } from '../../shared/agent-status-child-work-admission'
import type { AgentChildWorkRecord } from '../../shared/agent-status-child-work'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { reconcileAgentChildWorkEvidence } from '../../shared/agent-status-child-work-reconciliation'
import {
  agentChildWorkOwnedLiveness,
  deriveAgentChildDisplayState,
  projectAgentChildWorkViews
} from '../../shared/agent-status-child-work-view'
import { createAgentStatusStore } from '../../shared/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type { CodexBackgroundTaskEvent } from './codex-background-task-frames'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'

const PRIMARY = 'thread-parent'
const PARENT_TURN = 'turn-parent'
const CHILD = 'thread-child'
const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  },
  'session-1'
)

function turn(
  method: 'turn/started' | 'turn/completed',
  threadId: string,
  turnId: string,
  status = 'completed'
): CodexBackgroundTaskEvent {
  return { method, threadId, params: { threadId, turn: { id: turnId, status } } }
}

function spawned(
  child = CHILD,
  reporter = PRIMARY,
  name = 'audit_build'
): CodexBackgroundTaskEvent {
  return {
    method: 'item/started',
    threadId: reporter,
    params: {
      threadId: reporter,
      turnId: PARENT_TURN,
      item: {
        type: 'subAgentActivity',
        id: `activity-${child}`,
        kind: 'started',
        agentThreadId: child,
        agentPath: `/root/${name}`
      }
    }
  }
}

function item(
  method: 'item/started' | 'item/completed',
  threadId: string,
  turnId: string,
  fields: Record<string, unknown>
): CodexBackgroundTaskEvent {
  return { method, threadId, params: { threadId, turnId, item: fields } }
}

function shell(id: string, command: string, status = 'inProgress', source = 'agent') {
  return { type: 'commandExecution', id, command, source, status }
}

function harness() {
  const tracker = new CodexBackgroundTaskTracker(PRIMARY)
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  let clock = 1_000
  const log: AgentChildWorkEvidence[][] = []
  const send = (...events: CodexBackgroundTaskEvent[]): void => {
    for (const event of events) {
      tracker.observe(event)
      clock += 10
      const evidence = tracker.drainChildWorkEvidence(clock)
      log.push(evidence)
      reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'codex', evidence })
    }
  }
  const records = (): AgentChildWorkRecord[] => store.getChildren(parent)
  const byKind = (kind: AgentChildWorkRecord['kind']) =>
    records().filter((record) => record.kind === kind)
  const display = (childWorkId: string) => {
    const children = records()
    const views = projectAgentChildWorkViews(
      children,
      children.flatMap((child) => store.getAliasesForChild(child.childWorkId))
    )
    const view = views.find((candidate) => candidate.id === childWorkId)
    return view && deriveAgentChildDisplayState(view, agentChildWorkOwnedLiveness(views, view.id))
  }
  return { tracker, store, send, records, byKind, display, log }
}

/** A child spawned by the parent turn and running its first turn. */
function runningChild() {
  const run = harness()
  run.send(turn('turn/started', PRIMARY, PARENT_TURN), spawned(), turn('turn/started', CHILD, 'c1'))
  return run
}

describe('Codex child-work evidence', () => {
  it('records a spawned child by its thread, with its turn as the run', () => {
    const { records, store, log, send } = runningChild()
    // Codex delivers the announcement a second time, on `item/completed`.
    send({ ...spawned(), method: 'item/completed' })
    expect(records()).toEqual([
      expect.objectContaining({
        kind: 'agent',
        membership: 'live',
        state: 'working',
        residency: 'background',
        description: 'audit_build',
        invocation: { invocationId: 'c1', generation: 1 },
        stoppable: false
      })
    ])
    const aliases = store.getAliasesForChild(records()[0]!.childWorkId)
    expect(aliases.map(({ aliasKind, alias }) => [aliasKind, alias])).toEqual([
      ['thread_id', CHILD],
      ['turn_id', 'c1']
    ])
    // The host hears the child once.
    expect(log.flat().filter((edge) => edge.type === 'live')).toHaveLength(1)
  })

  it('makes no record for a child whose turn began before its announcement, until it lands', () => {
    const { send, records } = harness()
    send(turn('turn/started', PRIMARY, PARENT_TURN), turn('turn/started', CHILD, 'c1'))
    expect(records()).toEqual([])
    send(spawned())
    expect(records()).toEqual([expect.objectContaining({ membership: 'live', state: 'working' })])
  })

  it.each([
    ['completed', 'succeeded'],
    ['interrupted', 'cancelled'],
    ['failed', 'failed'],
    ['somethingNew', 'unknown']
  ])('settles a child whose own turn ended %s as %s', (status, outcome) => {
    const { send, tracker, records } = runningChild()
    send(turn('turn/completed', CHILD, 'c1', status))
    expect(records()).toEqual([
      expect.objectContaining({ membership: 'settled', state: 'done', outcome })
    ])
    // Today's strip drops the child the moment its turn ends; only the record keeps its ending.
    expect(tracker.state).toBeNull()
  })

  const childError = (
    turnId: string | undefined,
    willRetry: boolean
  ): CodexBackgroundTaskEvent => ({
    method: 'error',
    threadId: CHILD,
    params: {
      threadId: CHILD,
      ...(turnId ? { turnId } : {}),
      willRetry,
      error: { message: 'boom' }
    }
  })
  const childClosed: CodexBackgroundTaskEvent = {
    method: 'thread/closed',
    threadId: CHILD,
    params: { threadId: CHILD }
  }

  it.each([
    ['an error naming its turn that Codex will not retry', childError('c1', false), 'failed'],
    ['an error naming no turn that Codex will not retry', childError(undefined, false), 'failed'],
    ['its thread closing', childClosed, 'unknown']
  ])(
    'settles a working child whose turn ended with no turn/completed, by %s, in the strip and the record together',
    (_label, ending, outcome) => {
      const { send, tracker, records } = runningChild()
      expect(tracker.state?.tasks).toHaveLength(1)
      send(ending)
      expect(records()).toEqual([
        expect.objectContaining({ membership: 'settled', state: 'done', outcome })
      ])
      expect(tracker.state).toBeNull()
      // The first ending a turn gets stands.
      send(turn('turn/completed', CHILD, 'c1', 'completed'))
      expect(records()).toEqual([expect.objectContaining({ outcome })])
    }
  )

  it('keeps a child working through a retried error and a systemError status: its turn runs on', () => {
    const { send, tracker, records } = runningChild()
    send(childError('c1', true), {
      method: 'thread/status/changed',
      threadId: CHILD,
      params: { threadId: CHILD, status: { type: 'systemError' } }
    })
    expect(records()).toEqual([expect.objectContaining({ membership: 'live', state: 'working' })])
    expect(tracker.state?.tasks).toHaveLength(1)
    // A fatal error naming a turn the child already finished ends nothing.
    send(turn('turn/completed', CHILD, 'c1'), childError('c1', false))
    expect(records()).toEqual([expect.objectContaining({ outcome: 'succeeded' })])
  })

  it('never settles a child on its PARENT turn ending: children outlive the turn', () => {
    const { send, records } = runningChild()
    send(turn('turn/completed', PRIMARY, PARENT_TURN))
    expect(records()).toEqual([expect.objectContaining({ membership: 'live', state: 'working' })])
  })

  it('reopens the same record for a follow-up turn on a finished child, as a new run', () => {
    const { send, records } = runningChild()
    send(turn('turn/completed', CHILD, 'c1'))
    const [finished] = records()
    send(turn('turn/started', CHILD, 'c2'))
    expect(records()).toEqual([
      expect.objectContaining({
        childWorkId: finished!.childWorkId,
        membership: 'live',
        state: 'working',
        invocation: { invocationId: 'c2', generation: 2 },
        previousInvocations: [
          expect.objectContaining({
            fence: { invocationId: 'c1', generation: 1 },
            outcome: 'succeeded'
          })
        ]
      })
    ])
    // A late ending of the first run neither ends nor restarts the second.
    send(turn('turn/completed', CHILD, 'c1', 'failed'))
    expect(records()).toEqual([
      expect.objectContaining({
        membership: 'live',
        invocation: { invocationId: 'c2', generation: 2 }
      })
    ])
    send(turn('turn/completed', CHILD, 'c2', 'interrupted'))
    expect(records()).toEqual([
      expect.objectContaining({
        childWorkId: finished!.childWorkId,
        membership: 'settled',
        outcome: 'cancelled'
      })
    ])
  })

  it('says which tool the child has open, the way a CLI row names a Codex shell', () => {
    const { send, byKind } = runningChild()
    send(item('item/started', CHILD, 'c1', shell('cmd-1', 'npm test')))
    expect(byKind('agent')[0]?.operation).toEqual({
      toolName: 'Bash',
      input: 'npm test',
      basis: 'open',
      observedAt: 1_040
    })
    send(
      item('item/started', CHILD, 'c1', {
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'github',
        tool: 'search_issues',
        arguments: { query: 'flaky' },
        status: 'inProgress'
      })
    )
    expect(byKind('agent')[0]?.operation).toMatchObject({
      toolName: 'mcp__github__search_issues',
      input: 'flaky'
    })
    // The newer call ends first: the child is still running the older one, since it opened.
    send(
      item('item/completed', CHILD, 'c1', { type: 'mcpToolCall', id: 'mcp-1', status: 'completed' })
    )
    expect(byKind('agent')[0]?.operation).toEqual({
      toolName: 'Bash',
      input: 'npm test',
      basis: 'open',
      observedAt: 1_040
    })
    send(item('item/completed', CHILD, 'c1', shell('cmd-1', 'npm test', 'completed')))
    expect(byKind('agent')[0]?.operation).toBeUndefined()
  })

  it("never carries a run's open call into the next run when its ending was lost", () => {
    const { send, byKind } = runningChild()
    send(item('item/started', CHILD, 'c1', shell('cmd-1', 'npm test')))
    send(turn('turn/started', CHILD, 'c2'))
    expect(byKind('agent')[0]).toMatchObject({ invocation: { invocationId: 'c2', generation: 2 } })
    expect(byKind('agent')[0]?.operation).toBeUndefined()
  })

  it('keeps what the child said last, and its usage, through to how it ended', () => {
    const { send, byKind } = runningChild()
    send(
      item('item/completed', CHILD, 'c1', {
        type: 'agentMessage',
        id: 'msg-1',
        text: 'Two tests\nflake on CI'
      }),
      {
        method: 'thread/tokenUsage/updated',
        threadId: CHILD,
        params: { threadId: CHILD, tokenUsage: { total: { totalTokens: 4_200 } } }
      }
    )
    expect(byKind('agent')[0]).toMatchObject({
      lastMessage: 'Two tests flake on CI',
      totalTokens: 4_200
    })
    send(turn('turn/completed', CHILD, 'c1'))
    expect(byKind('agent')[0]).toMatchObject({
      membership: 'settled',
      outcome: 'succeeded',
      lastMessage: 'Two tests flake on CI',
      totalTokens: 4_200
    })
    // A new run has said nothing yet.
    send(turn('turn/started', CHILD, 'c2'))
    expect(byKind('agent')[0]).not.toHaveProperty('lastMessage')
  })

  it('files a message whose frame names no turn under the run that said it, never the next', () => {
    const { send, byKind } = runningChild()
    send({
      method: 'item/completed',
      threadId: CHILD,
      params: { threadId: CHILD, item: { type: 'agentMessage', id: 'msg-1', text: 'Done' } }
    })
    expect(byKind('agent')[0]?.lastMessage).toBe('Done')
    send(turn('turn/completed', CHILD, 'c1'), turn('turn/started', CHILD, 'c2'))
    send(turn('turn/completed', CHILD, 'c2'))
    expect(byKind('agent')[0]).toMatchObject({ outcome: 'succeeded' })
    expect(byKind('agent')[0]).not.toHaveProperty('lastMessage')
  })

  it('reads a child waiting on the user from its own thread status', () => {
    const { send, byKind } = runningChild()
    const status = (status: unknown): CodexBackgroundTaskEvent => ({
      method: 'thread/status/changed',
      threadId: CHILD,
      params: { threadId: CHILD, status }
    })
    send(status({ type: 'active', activeFlags: ['waitingOnApproval'] }))
    expect(byKind('agent')[0]?.state).toBe('waiting')
    send(status({ type: 'active', activeFlags: [] }))
    expect(byKind('agent')[0]?.state).toBe('working')
    send(status({ type: 'active', activeFlags: ['waitingOnUserInput'] }))
    send(turn('turn/completed', CHILD, 'c1'))
    send(turn('turn/started', CHILD, 'c2'))
    // The wait ended with the turn that asked.
    expect(byKind('agent')[0]?.state).toBe('working')
  })

  it("owns the child's persistent command, so a finished child reads monitoring while it runs", () => {
    const { send, byKind, display } = runningChild()
    send(
      item(
        'item/started',
        CHILD,
        'c1',
        shell('exec-1', 'npm run dev', 'inProgress', 'unifiedExecStartup')
      )
    )
    const [agent] = byKind('agent')
    expect(byKind('command')).toEqual([
      expect.objectContaining({
        membership: 'live',
        description: 'npm run dev',
        parentChildWorkId: agent!.childWorkId
      })
    ])
    // A persistent command is work of its own, never the tool the child is running.
    expect(agent?.operation).toBeUndefined()
    send(turn('turn/completed', CHILD, 'c1'))
    expect(byKind('agent')[0]).toMatchObject({ membership: 'settled', outcome: 'succeeded' })
    expect(display(agent!.childWorkId)).toBe('monitoring')
    send(
      item('item/completed', CHILD, 'c1', {
        ...shell('exec-1', 'npm run dev', 'completed', 'unifiedExecStartup'),
        exitCode: 1
      })
    )
    expect(byKind('command')[0]).toMatchObject({ membership: 'settled', outcome: 'failed' })
    expect(display(agent!.childWorkId)).toBe('done')
  })

  it("names the owner of a command launched before the host held its child's record", () => {
    const { send, byKind } = harness()
    send(
      turn('turn/started', PRIMARY, PARENT_TURN),
      turn('turn/started', CHILD, 'c1'),
      item(
        'item/started',
        CHILD,
        'c1',
        shell('exec-1', 'tail -f log', 'inProgress', 'unifiedExecStartup')
      )
    )
    expect(byKind('command')[0]).not.toHaveProperty('parentChildWorkId')
    send(spawned())
    expect(byKind('command')[0]?.parentChildWorkId).toBe(byKind('agent')[0]?.childWorkId)
  })

  it("records the session's own persistent command with no owner", () => {
    const { send, byKind } = harness()
    send(
      item(
        'item/started',
        PRIMARY,
        PARENT_TURN,
        shell('exec-9', 'sleep 90', 'inProgress', 'unifiedExecStartup')
      )
    )
    expect(byKind('command')).toEqual([
      expect.objectContaining({ membership: 'live', description: 'sleep 90' })
    ])
    expect(byKind('command')[0]).not.toHaveProperty('parentChildWorkId')
  })

  it('names the child that spawned a nested child as its owner', () => {
    const { send, byKind } = runningChild()
    send(
      spawned('thread-grandchild', CHILD, 'lint'),
      turn('turn/started', 'thread-grandchild', 'g1')
    )
    const nested = byKind('agent').find((record) => record.description === 'lint')
    const owner = byKind('agent').find((record) => record.description === 'audit_build')
    expect(nested?.parentChildWorkId).toBe(owner?.childWorkId)
  })

  it('holds no evidence for a session with nowhere to deliver it', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(spawned())
    tracker.observe(turn('turn/started', CHILD, 'c1'))
    tracker.publishChildWork()
    expect(tracker.drainChildWorkEvidence(1)).toEqual([])
  })

  it('drops every record when the provider session ends', () => {
    const { send, tracker, records, store } = runningChild()
    send(
      item(
        'item/started',
        CHILD,
        'c1',
        shell('exec-1', 'npm run dev', 'inProgress', 'unifiedExecStartup')
      )
    )
    expect(records()).toHaveLength(2)
    tracker.clear()
    const evidence = tracker.drainChildWorkEvidence(9_000)
    expect(evidence).toEqual([{ type: 'session-ended', observedAt: 9_000 }])
    reconcileAgentChildWorkEvidence({
      store,
      admission: createAgentChildWorkAdmission(store, { mintChildWorkId: () => 'unused' }),
      parent,
      provider: 'codex',
      evidence
    })
    expect(records()).toEqual([])
  })
})
