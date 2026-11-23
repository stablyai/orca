import { expect, it } from 'vitest'
import type { AgentSessionTurnCompletionEvent } from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { AgentChildWorkLivenessCandidate } from '../../../../shared/agent-status/child-work/agent-status-child-work-liveness'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'

const location = { kind: 'local' } as const

function turn(id: string, running: boolean): StructuredAgentSessionStatusState {
  const state = {
    latestRequest: {
      kind: 'turn',
      id,
      turnState: running ? 'running' : 'completed',
      outcome: running ? null : 'success',
      settledAt: running ? undefined : 1
    },
    owesWork: false,
    pendingPromptIds: [],
    summary: { status: running ? 'working' : 'idle' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields the feed reads.
  return state as unknown as StructuredAgentSessionStatusState
}

it('tells a held answer at its own end, once, to those who hear held ends, before a later quiet turn', () => {
  let workers: readonly AgentChildWorkLivenessCandidate[] = []
  const feed = new StructuredAgentSessionTurnCompletionFeed({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the feed reads only params here.
    sessions: new Map([['chat', { params: { location } }]]) as never,
    now: () => 10,
    readStatusState: async () => null,
    readChildWork: () => workers
  })
  const ends = (held: boolean) => {
    const seen: string[] = []
    feed.subscribe({
      id: held ? 'held' : 'plain',
      includePrompts: true,
      ...(held ? { includeHeld: true } : {}),
      emit: (event: AgentSessionTurnCompletionEvent) => {
        if (event.type === 'completion') {
          seen.push(event.completion.turnId)
        }
      }
    })
    return seen
  }
  const heard = ends(true)
  const plain = ends(false)
  let sequence = 0
  const observe = (state: StructuredAgentSessionStatusState) =>
    feed.observeProjection('chat', { epoch: 'e', sequence: (sequence += 1), state })

  observe(turn('answer', true))
  observe(turn('answer', true))
  // The answer ends while the worker it started still runs.
  workers = [{ kind: 'agent', state: 'working' }]
  observe(turn('answer', false))
  observe(turn('answer', false))
  expect({ heard: [...heard], plain: [...plain] }).toEqual({ heard: ['answer'], plain: [] })

  // The worker's mail wakes the chat while it still runs, and that turn ends quiet.
  observe(turn('mail', true))
  observe(turn('mail', false))
  // The worker finishes: everyone hears the newest end, those who heard it held don't hear it twice.
  workers = []
  observe(turn('mail', false))
  expect({ heard, plain }).toEqual({ heard: ['answer', 'mail'], plain: ['mail'] })
})
