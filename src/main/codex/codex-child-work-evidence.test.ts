import { describe, expect, it } from 'vitest'
import { createAgentChildWorkAdmission } from '../../shared/agent-status-child-work-admission'
import type { AgentChildWorkRecord } from '../../shared/agent-status-child-work'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { reconcileAgentChildWorkEvidence } from '../../shared/agent-status-child-work-reconciliation'
import {
  agentChildWorkOwnedLiveness,
  deriveAgentChildDisplayState
} from '../../shared/agent-status-child-work-display'
import { projectAgentChildWorkViews } from '../../shared/agent-status-child-work-view'
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

  const childError = (turnId: string, willRetry: boolean): CodexBackgroundTaskEvent => ({
    method: 'error',
    threadId: CHILD,
    params: { threadId: CHILD, turnId, willRetry, error: { message: 'boom' } }
  })
  const childClosed: CodexBackgroundTaskEvent = {
    method: 'thread/closed',
    threadId: CHILD,
    params: { threadId: CHILD }
  }

  it('keeps a child working through an error Codex will not retry, and settles it on the failed turn/completed that follows', () => {
    const { send, tracker, records } = runningChild()
    send(childError('c1', false))
    expect(records()).toEqual([expect.objectContaining({ membership: 'live' })])
    expect(tracker.state?.tasks).toHaveLength(1)
    send(turn('turn/completed', CHILD, 'c1', 'failed'))
    expect(records()).toEqual([
      expect.objectContaining({ membership: 'settled', state: 'done', outcome: 'failed' })
    ])
    expect(tracker.state).toBeNull()
  })

  it('settles a working child whose thread closed with no turn/completed, in the strip and the record together', () => {
    const { send, tracker, records } = runningChild()
    expect(tracker.state?.tasks).toHaveLength(1)
    send(childClosed)
    expect(records()).toEqual([
      expect.objectContaining({ membership: 'settled', state: 'done', outcome: 'unknown' })
    ])
    expect(tracker.state).toBeNull()
    // The first ending a turn gets stands.
    send(turn('turn/completed', CHILD, 'c1', 'completed'))
    expect(records()).toEqual([expect.objectContaining({ outcome: 'unknown' })])
  })

  it('keeps a child working through a retried error and a systemError status: its turn runs on', () => {
    const { send, tracker, records } = runningChild()
    send(childError('c1', true), {
      method: 'thread/status/changed',
      threadId: CHILD,
      params: { threadId: CHILD, status: { type: 'systemError' } }
    })
    expect(records()).toEqual([expect.objectContaining({ membership: 'live', state: 'working' })])
    expect(tracker.state?.tasks).toHaveLength(1)
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

  it('names a unified-exec shell as the open call until its process exits', () => {
    const { send, byKind } = runningChild()
    // Codex runs every agent shell through unified exec, not only the ones that outlive a turn.
    send(
      item(
        'item/started',
        CHILD,
        'c1',
        shell('exec-1', 'npm test', 'inProgress', 'unifiedExecStartup')
      )
    )
    expect(byKind('agent')[0]?.operation).toMatchObject({ toolName: 'Bash', input: 'npm test' })
    send(
      item(
        'item/completed',
        CHILD,
        'c1',
        shell('exec-1', 'npm test', 'completed', 'unifiedExecStartup')
      )
    )
    expect(byKind('agent')[0]?.operation).toBeUndefined()
    // An approved command starts on the approval path and completes from unified exec.
    send(item('item/started', CHILD, 'c1', shell('exec-2', 'touch ~/marker')))
    expect(byKind('agent')[0]?.operation).toMatchObject({
      toolName: 'Bash',
      input: 'touch ~/marker'
    })
    send(
      item(
        'item/completed',
        CHILD,
        'c1',
        shell('exec-2', 'touch ~/marker', 'completed', 'unifiedExecStartup')
      )
    )
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

  it('records a command from its start until its process exits, then removes it', () => {
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
    // While the child's turn runs, the command is also the tool it has open.
    expect(agent?.operation).toMatchObject({ toolName: 'Bash', input: 'npm run dev' })
    expect(byKind('command')).toEqual([
      expect.objectContaining({
        membership: 'live',
        description: 'npm run dev',
        residency: 'background',
        parentChildWorkId: agent!.childWorkId,
        firstObservedAt: 1_040
      })
    ])
    send(turn('turn/completed', CHILD, 'c1'))
    expect(byKind('agent')[0]).toMatchObject({ membership: 'settled', outcome: 'succeeded' })
    expect(byKind('command')).toEqual([expect.objectContaining({ membership: 'live' })])
    expect(display(agent!.childWorkId)).toBe('monitoring')
    send(
      item('item/completed', CHILD, 'c1', {
        ...shell('exec-1', 'npm run dev', 'completed', 'unifiedExecStartup'),
        exitCode: 1
      })
    )
    expect(byKind('command')).toEqual([])
    expect(display(agent!.childWorkId)).toBe('done')
  })

  it('records an approved command while it runs, whatever source Codex starts it with', () => {
    const { send, tracker, byKind, display } = runningChild()
    // The approval path starts the item as `agent`; unified exec reports its exit.
    send(item('item/started', CHILD, 'c1', shell('exec-2', 'npm run dev')))
    const [agent] = byKind('agent')
    expect(byKind('command')).toEqual([
      expect.objectContaining({ membership: 'live', parentChildWorkId: agent!.childWorkId })
    ])
    send(turn('turn/completed', CHILD, 'c1'))
    expect(display(agent!.childWorkId)).toBe('monitoring')
    expect(tracker.state?.tasks).toEqual([expect.objectContaining({ kind: 'command' })])
    send(
      item(
        'item/completed',
        CHILD,
        'c1',
        shell('exec-2', 'npm run dev', 'completed', 'unifiedExecStartup')
      )
    )
    expect(byKind('command')).toEqual([])
    expect(display(agent!.childWorkId)).toBe('done')
    expect(tracker.state).toBeNull()
  })

  it("removes a closed thread's running commands: Codex stops them and never reports their exit", () => {
    const { send, tracker, byKind, display } = runningChild()
    send(
      item(
        'item/started',
        CHILD,
        'c1',
        shell('exec-1', 'npm run dev', 'inProgress', 'unifiedExecStartup')
      ),
      turn('turn/completed', CHILD, 'c1'),
      turn('turn/completed', PRIMARY, PARENT_TURN)
    )
    const [agent] = byKind('agent')
    expect(display(agent!.childWorkId)).toBe('monitoring')
    send({ method: 'thread/closed', threadId: CHILD, params: { threadId: CHILD } })
    expect(byKind('command')).toEqual([])
    expect(display(agent!.childWorkId)).toBe('done')
    expect(tracker.state).toBeNull()
    // The exit Codex could not deliver starts nothing if it ever arrives.
    send(
      item(
        'item/completed',
        CHILD,
        'c1',
        shell('exec-1', 'npm run dev', 'completed', 'unifiedExecStartup')
      )
    )
    expect(byKind('command')).toEqual([])
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
    expect(byKind('command')).toEqual([
      expect.not.objectContaining({ parentChildWorkId: expect.anything() })
    ])
    send(spawned())
    expect(byKind('command')).toEqual([
      expect.objectContaining({
        description: 'tail -f log',
        parentChildWorkId: byKind('agent')[0]?.childWorkId
      })
    ])
  })

  it("records the session's own command with no owner from its start", () => {
    const { send, byKind } = harness()
    send(
      turn('turn/started', PRIMARY, PARENT_TURN),
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
    send(turn('turn/completed', PRIMARY, PARENT_TURN))
    expect(byKind('command')).toEqual([expect.objectContaining({ membership: 'live' })])
  })

  it('leaves no record behind a finished shell, so none displaces a finished child', () => {
    const { send, byKind, records, log } = runningChild()
    send(turn('turn/completed', CHILD, 'c1'))
    const before = log.length
    // Codex runs every shell, however short, the way it runs one left running.
    for (let index = 0; index < 40; index += 1) {
      const id = `exec-${index}`
      send(
        item('item/started', PRIMARY, PARENT_TURN, {
          ...shell(id, 'rg foo', 'inProgress', 'unifiedExecStartup'),
          durationMs: 0
        })
      )
      expect(byKind('command')).toEqual([expect.objectContaining({ description: 'rg foo' })])
      send(
        item('item/completed', PRIMARY, PARENT_TURN, {
          ...shell(id, 'rg foo', 'completed', 'unifiedExecStartup'),
          exitCode: 0
        })
      )
      expect(byKind('command')).toEqual([])
    }
    send(turn('turn/completed', PRIMARY, PARENT_TURN))
    expect(records()).toEqual([
      expect.objectContaining({ kind: 'agent', membership: 'settled', outcome: 'succeeded' })
    ])
    // One edge when each shell starts and one when it exits, as the strip republishes today.
    expect(
      log
        .slice(before)
        .flat()
        .map((edge) => edge.type)
    ).toEqual(Array.from({ length: 40 }, () => ['live', 'removed']).flat())
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

  it('settles every live child with no reported outcome, and removes every command, when the provider session ends', () => {
    const { send, tracker, records, store } = runningChild()
    send(
      item(
        'item/started',
        PRIMARY,
        PARENT_TURN,
        shell('exec-1', 'npm run dev', 'inProgress', 'unifiedExecStartup')
      ),
      turn('turn/completed', PRIMARY, PARENT_TURN)
    )
    expect(records()).toHaveLength(2)
    tracker.clear()
    const evidence = tracker.drainChildWorkEvidence(9_000)
    expect(evidence).toEqual([
      {
        type: 'removed',
        observedAt: 9_000,
        handle: { idKind: 'task_id', id: 'codex-command:primary:exec-1' }
      },
      { type: 'session-ended', observedAt: 9_000 }
    ])
    reconcileAgentChildWorkEvidence({
      store,
      admission: createAgentChildWorkAdmission(store, { mintChildWorkId: () => 'unused' }),
      parent,
      provider: 'codex',
      evidence
    })
    expect(records()).toEqual([
      expect.objectContaining({ kind: 'agent', membership: 'settled', outcome: 'unknown' })
    ])
  })
})
