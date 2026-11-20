import { describe, expect, it } from 'vitest'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'

function state(input: {
  turnState: 'running' | 'interrupted' | 'completed'
  outcome: 'success' | null
  owesWork?: boolean
}): StructuredAgentSessionStatusState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the feed reads only these fields of a status state.
  return {
    latestRequest: {
      kind: 'turn',
      id: 'turn-1',
      turnState: input.turnState,
      outcome: input.outcome
    },
    owesWork: input.owesWork ?? false,
    pendingPromptIds: [],
    summary: { status: 'idle' }
  } as unknown as StructuredAgentSessionStatusState
}

describe('a chat coming to rest', () => {
  const feed = () =>
    new StructuredAgentSessionTurnCompletionFeed({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the feed reads only a session's journal cursor and location.
      sessions: new Map([
        [
          'chat',
          { journal: { cursor: () => ({ epoch: 'e', sequence: 0 }) }, params: { location: {} } }
        ]
      ]) as never,
      now: () => 0,
      readStatusState: async () => null,
      readChildWork: () => undefined
    })

  it('is announced for a stopped turn with no recorded outcome, which completes nothing', () => {
    const subject = feed()
    const rested: string[] = []
    const completions: unknown[] = []
    subject.subscribe({
      id: 'test',
      emit: (event) => completions.push(event),
      onRest: (id) => rested.push(id)
    })
    subject.observeProjection('chat', {
      epoch: 'e',
      sequence: 1,
      state: state({ turnState: 'running', outcome: null })
    })
    subject.observeProjection('chat', {
      epoch: 'e',
      sequence: 2,
      state: state({ turnState: 'interrupted', outcome: null })
    })
    expect(rested).toEqual(['chat'])
    expect(completions).toEqual([])
  })

  it('is not reached while a queued turn is still owed', () => {
    const subject = feed()
    expect(
      subject.restOf('chat', state({ turnState: 'completed', outcome: 'success', owesWork: true }))
    ).toEqual({
      kind: 'busy'
    })
    expect(subject.restOf('chat', state({ turnState: 'completed', outcome: 'success' }))).toEqual({
      kind: 'rest',
      outcome: 'success'
    })
  })
})
