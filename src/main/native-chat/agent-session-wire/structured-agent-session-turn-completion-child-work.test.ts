import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentChildWorkLivenessCandidate } from '../../../shared/agent-status-child-work-liveness'
import { projectStructuredAgentSessionStatusState } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'

const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
} as const
const SUBAGENT = { kind: 'agent', state: 'working' } as const
const DEV_SERVER = { kind: 'command', state: 'working' } as const

function turnItem(lifecycle: AgentJournalTurnLifecycle, sequence = 2): AgentJournalRenderItem {
  return {
    itemId: `codex:turn:${lifecycle.turnId}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'turn', ...lifecycle }
  }
}

// A turn the agent opened itself keys its lifecycle row to itself.
function selfStarted(lifecycle: AgentJournalTurnLifecycle): AgentJournalTurnLifecycle {
  return { ...lifecycle, userItemId: `codex:turn:${lifecycle.turnId}` }
}

function harness(childWork: AgentChildWorkLivenessCandidate[]) {
  let items: AgentJournalRenderItem[] = []
  let submissions: AgentJournalSubmission[] = []
  let sequence = 0
  const journal = { cursor: () => ({ epoch: 'epoch-1', sequence }) }
  const feed = new StructuredAgentSessionTurnCompletionFeed({
    sessions: new Map([['session-1', { journal, params: { location: LOCATION } }]]),
    now: () => 1_700,
    readStatusState: () => projectStructuredAgentSessionStatusState(items, submissions),
    readChildWork: () => childWork
  })
  const outcomes: [string, string][] = []
  feed.subscribe({
    id: 'sub',
    emit: (event) => {
      if (event.type === 'completion') {
        outcomes.push([event.completion.turnId, event.completion.outcome])
      }
    }
  })
  const commit = (next: AgentJournalRenderItem[], nextSubmissions: AgentJournalSubmission[]) => {
    items = next
    submissions = nextSubmissions
    sequence += 1
    feed.observe('session-1')
  }
  return {
    outcomes,
    feed,
    commit,
    settle: (lifecycle: AgentJournalTurnLifecycle) => {
      commit([turnItem({ ...lifecycle, state: 'running', outcome: undefined })], [])
      commit([turnItem(lifecycle)], [])
    }
  }
}

describe('a turn that settles while its child work is still live', () => {
  it('holds the finish until the last subagent drains, then announces that turn once', () => {
    const childWork: AgentChildWorkLivenessCandidate[] = [SUBAGENT]
    const h = harness(childWork)
    h.settle({ turnId: 'turn-1', state: 'completed', outcome: 'success' })
    expect(h.outcomes).toEqual([])

    childWork[0] = { ...SUBAGENT, state: 'done' }
    h.feed.observe('session-1')
    h.feed.observe('session-1')
    expect(h.outcomes).toEqual([['turn-1', 'success']])
  })

  it('holds a coordinator waiting on workers through a background orca orchestration check --wait', () => {
    const h = harness([{ ...DEV_SERVER, operation: { input: 'orca orchestration check --wait' } }])
    h.settle({ turnId: 'turn-1', state: 'completed', outcome: 'success' })
    expect(h.outcomes).toEqual([])
  })

  it('does not hold a failed turn', () => {
    const h = harness([SUBAGENT])
    h.settle({ turnId: 'turn-1', state: 'completed', outcome: 'failure' })
    expect(h.outcomes).toEqual([['turn-1', 'failure']])
  })

  it('lets a dev server hold only a turn the agent started itself, with nothing steered into it', () => {
    const user = harness([DEV_SERVER])
    user.settle({ turnId: 'turn-1', state: 'completed', outcome: 'success' })
    expect(user.outcomes).toEqual([['turn-1', 'success']])

    const woken = harness([DEV_SERVER])
    woken.settle(selfStarted({ turnId: 'wake-1', state: 'completed', outcome: 'success' }))
    expect(woken.outcomes).toEqual([])

    const steered = harness([DEV_SERVER])
    const steer: AgentJournalSubmission = {
      clientMessageId: 'm1',
      fence: 1,
      payloadFingerprint: 'm1',
      providerItemId: null,
      reason: null,
      submittedAt: 10,
      resolvedAt: 20,
      handoverRecorded: true,
      dispatchState: 'accepted',
      answeredInTurn: { turnItemId: 'codex:turn:wake-1', via: 'steer' }
    }
    const message: AgentJournalRenderItem = {
      itemId: agentJournalSubmissionKey('m1'),
      revision: 0,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'm1' }] }
    }
    steered.commit(
      [message, turnItem(selfStarted({ turnId: 'wake-1', state: 'running' }))],
      [steer]
    )
    steered.commit(
      [
        message,
        turnItem(selfStarted({ turnId: 'wake-1', state: 'completed', outcome: 'success' }))
      ],
      [steer]
    )
    expect(steered.outcomes).toEqual([['wake-1', 'success']])
  })
})
