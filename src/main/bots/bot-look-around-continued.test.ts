import { describe, expect, it } from 'vitest'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session/view/agent-session-turn-completion-wire'
import { settleContinuedLook } from './bot-look-around-continued'
import {
  beginRun,
  endRun,
  suggest,
  upNextItems,
  upNextState,
  type SuggestInput
} from './bot-look-around-state'
import { BotLookAroundStore } from './bot-look-around-store'

const idea: SuggestInput = { title: 'Review #12', why: 'It waits on you', ask: 'Review #12' }
const RESET = 50_000

function completion(
  sessionId: string,
  outcome: 'success' | 'failure' = 'success'
): AgentSessionTurnCompletionEvent {
  return {
    type: 'completion',
    completion: {
      scope: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder:fw-b1',
        workspaceKind: 'folder'
      },
      sessionId,
      turnId: `turn-${sessionId}`,
      outcome,
      completedAt: 0
    }
  }
}

/** A look its usage limit stopped, as the runner records it. */
function stoppedLook(): BotLookAroundStore {
  const store = new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
  store.update('b1', (state) => ({
    state: endRun(
      beginRun(state, 'look-1', 1_000),
      'look-1',
      2_000,
      "The last look didn't finish.",
      false,
      false,
      { resetsAt: RESET }
    ),
    result: undefined
  }))
  return store
}

describe('a look continued past its usage limit', () => {
  it('keeps suggestions from the continued turn and clears the failure when it succeeds', () => {
    const store = stoppedLook()
    store.update('b1', (state) => {
      const next = suggest(state, 'look-1', idea, RESET + 1)
      expect(next.outcome.ok).toBe(true)
      return { state: next.state, result: undefined }
    })
    settleContinuedLook(store, completion('look-1'), RESET + 60_000)
    const state = upNextState(store.get('b1'), undefined)
    expect(state.error).toBeUndefined()
    expect(state.lastLookedAt).toBe(RESET + 60_000)
    expect(upNextItems(store.get('b1'), RESET + 60_000)).toEqual([
      expect.objectContaining({ title: 'Review #12' })
    ])
    expect(store.get('b1').runs[0]).toEqual({
      sessionId: 'look-1',
      startedAt: 1_000,
      endedAt: RESET + 60_000
    })
  })

  it('stays stopped through a failed turn, and other sessions change nothing', () => {
    const store = stoppedLook()
    const before = store.get('b1')
    settleContinuedLook(store, completion('look-1', 'failure'), RESET + 60_000)
    settleContinuedLook(store, completion('some-chat'), RESET + 60_000)
    expect(store.get('b1')).toBe(before)
  })

  it('leaves a newer look and its list alone when an older stopped look is continued', () => {
    const store = stoppedLook()
    store.update('b1', (state) => ({ state: beginRun(state, 'look-2', 3_000), result: undefined }))
    store.update('b1', (state) => ({
      state: suggest(state, 'look-2', idea, 4_000).state,
      result: 0
    }))
    const before = store.get('b1')
    settleContinuedLook(store, completion('look-1'), RESET + 60_000)
    expect(store.get('b1')).toBe(before)
    expect(suggest(before, 'look-1', idea, RESET + 1).outcome.ok).toBe(false)
  })

  it('leaves a look that failed for another reason failed', () => {
    const store = new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
    store.update('b1', (state) => ({
      state: endRun(beginRun(state, 'look-1', 1_000), 'look-1', 2_000, 'Timed out.'),
      result: undefined
    }))
    settleContinuedLook(store, completion('look-1'), RESET)
    expect(upNextState(store.get('b1'), undefined).error).toBe('Timed out.')
    expect(suggest(store.get('b1'), 'look-1', idea, RESET).outcome.ok).toBe(false)
  })
})
