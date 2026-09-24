import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import type { AgentSessionBackgroundTaskStops } from './structured-agent-session-adapter'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

const TARGETED: AgentSessionBackgroundTaskStops = { supportsTaskStop: true, supportsStopAll: true }
const UNTARGETED: AgentSessionBackgroundTaskStops = {
  supportsTaskStop: false,
  supportsStopAll: true
}
const NO_STOP: AgentSessionBackgroundTaskStops = { supportsTaskStop: false, supportsStopAll: false }

function contextWith(stops: AgentSessionBackgroundTaskStops | undefined): AgentSessionTurnContext {
  return {
    sessionId: 'session-1',
    journal: {
      snapshot: () => ({ items: [] }),
      submissions: () => []
    },
    adapter: {
      backgroundTaskStops: () => stops,
      // The provider tracker's roster, claiming live work: admission must not consult it.
      backgroundTaskState: () => ({ state: 'monitoring', tasks: [{ id: 'tracker-only' }] })
    }
  } as unknown as AgentSessionTurnContext
}

function child(overrides: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id: 'child-1',
    providerId: 'task-1',
    kind: 'command',
    description: 'npm run dev',
    state: 'working',
    membership: 'live',
    firstObservedAt: 100,
    observedAt: 200,
    stoppable: true,
    invocation: { invocationId: 'spawn-1', generation: 1 },
    ...overrides
  }
}

const SETTLED = child({
  state: 'done',
  membership: 'settled',
  outcome: 'succeeded',
  settledAt: 300
})
const RECORD = { lease: {} } as unknown as AgentSessionRecord
const STOP = 'Stop background tasks before using this command.'
const WAIT = 'Wait for background tasks to finish before using this command.'

describe('conversationCommandBlocked background work', () => {
  it('admits the command when the strip lists nothing, whatever the provider tracker holds', () => {
    expect(conversationCommandBlocked(contextWith(TARGETED), RECORD, [])).toBeNull()
    // The parent row has not landed, so the strip has no records to show either.
    expect(conversationCommandBlocked(contextWith(TARGETED), RECORD, undefined)).toBeNull()
  })

  it('admits the command when the strip lists only finished children', () => {
    expect(conversationCommandBlocked(contextWith(TARGETED), RECORD, [SETTLED])).toBeNull()
  })

  it('asks for a stop when the strip offers one on a live row', () => {
    expect(conversationCommandBlocked(contextWith(TARGETED), RECORD, [SETTLED, child()])).toBe(STOP)
  })

  it('asks for a stop when the strip offers its single untargeted stop', () => {
    const live = child({ stoppable: false })
    expect(conversationCommandBlocked(contextWith(UNTARGETED), RECORD, [live])).toBe(STOP)
  })

  it('asks the user to wait when no live row on the strip has a stop', () => {
    // A targeted-stop provider renders no untargeted stop, so these rows offer nothing.
    const unstoppable = child({ stoppable: false })
    const unaddressable = child({ id: 'child-2', providerId: undefined })
    expect(
      conversationCommandBlocked(contextWith(TARGETED), RECORD, [unstoppable, unaddressable])
    ).toBe(WAIT)
  })

  it('asks the user to wait when the provider exposes no stop at all', () => {
    // Codex: an instruction to stop would name a control that does not exist.
    expect(conversationCommandBlocked(contextWith(NO_STOP), RECORD, [child()])).toBe(WAIT)
    // No live provider session answers for it either.
    expect(conversationCommandBlocked(contextWith(undefined), RECORD, [child()])).toBe(WAIT)
  })

  it('still refuses on the open turn, not on the work the strip now shows', () => {
    // The strip reports subagents while a turn runs. That must not change which
    // refusal the user sees: an open turn already refuses, and it refuses first,
    // so a live fan-out never re-labels the reason or blocks anything new.
    const ctx = contextWith(TARGETED)
    ctx.journal.snapshot = () =>
      ({
        items: [
          {
            id: 'turn-1',
            body: {
              kind: 'status',
              turnLifecycle: { turnId: 'turn-1', state: 'running' }
            }
          }
        ]
      }) as unknown as ReturnType<typeof ctx.journal.snapshot>
    expect(conversationCommandBlocked(ctx, RECORD, [child()])).toBe(
      'Wait for the current turn to finish before using this command.'
    )
  })
})
