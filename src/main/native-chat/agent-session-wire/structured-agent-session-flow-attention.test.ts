import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-wire'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'

const location = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-1',
  workspaceKind: 'folder'
} as const
function harness() {
  let item: AgentJournalRenderItem | undefined
  let workPending = false
  let sequence = 0
  const events: AgentSessionTurnCompletionEvent[] = []
  const sessions = new Map([
    [
      'session-1',
      { journal: { cursor: () => ({ epoch: 'epoch-1', sequence }) }, params: { location } }
    ]
  ])
  const readStatusState = () => projectStructuredAgentSessionStatusState(item ? [item] : [])
  const feed = new StructuredAgentSessionTurnCompletionFeed({
    sessions,
    now: () => 1700,
    readStatusState,
    readFlowState: () => {
      const state = readStatusState()
      return {
        hostId: 'local',
        rootId: 'session-1',
        flowId: 'user-request-1',
        parentEnded: state.latestRequest?.turnState !== 'running',
        outcome: state.latestRequest?.outcome ?? undefined,
        children: [],
        inventoryKnown: true,
        pendingPromptIds: state.pendingPromptIds,
        owesWork: state.owesWork || workPending,
        live: true
      }
    }
  })
  return {
    events,
    feed,
    listen: (includeFlowAttention: boolean) =>
      feed.subscribe({
        id: 'listener',
        emit: (event) => events.push(event),
        includePrompts: true,
        includeFlowAttention
      }),
    work: (pending: boolean) => {
      workPending = pending
      feed.observeFlow('session-1')
    },
    turn: (
      state: AgentJournalTurnLifecycle['state'],
      outcome?: AgentJournalTurnLifecycle['outcome']
    ) => {
      sequence++
      item = {
        itemId: 'turn-1',
        revision: sequence,
        sequence,
        observedAt: sequence,
        body: { kind: 'turn', turnId: 'turn-1', state, ...(outcome ? { outcome } : {}) }
      }
      feed.observe('session-1')
    }
  }
}
afterEach(() => vi.useRealTimers())
describe('whole-flow attention beside ordinary turn news', () => {
  it('keeps ordinary turn edges immediate while flow alerts wait for background work and quiet', () => {
    vi.useFakeTimers()
    const h = harness()
    h.listen(true)
    h.turn('running')
    h.work(true)
    h.turn('completed', 'success')
    vi.advanceTimersByTime(10000)
    expect(h.events.map((event) => event.type)).toEqual(['completion'])
    h.work(false)
    vi.advanceTimersByTime(1499)
    expect(h.events).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(h.events.map((event) => event.type)).toEqual(['completion', 'flow-attention'])
    const flow = h.events[1]
    expect(flow.type === 'flow-attention' && flow.edge.flowAlert.reason).toBe('flow-complete')
    h.feed.dispose()
  })
  it('never sends flow events to a legacy subscriber', () => {
    vi.useFakeTimers()
    const h = harness()
    h.listen(false)
    h.turn('running')
    h.turn('completed', 'success')
    vi.advanceTimersByTime(1500)
    expect(h.events.map((event) => event.type)).toEqual(['completion'])
    h.feed.dispose()
  })
  it('releases pending timers when the owning session retires', () => {
    vi.useFakeTimers()
    const h = harness()
    h.listen(true)
    h.turn('running')
    h.turn('completed', 'success')
    h.feed.forget('session-1')
    vi.advanceTimersByTime(1500)
    expect(h.events.map((event) => event.type)).toEqual(['completion'])
  })
})
