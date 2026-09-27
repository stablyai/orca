import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatus } from '../../../shared/structured-agent-session-projection'
import { releaseStructuredAgentSessionUnansweredDispatches } from './structured-agent-session-host-mutations'

const FENCE = 7

function submission(over: Partial<AgentJournalSubmission>): AgentJournalSubmission {
  return {
    clientMessageId: 'm-1',
    fence: FENCE,
    payloadFingerprint: 'fp',
    dispatchState: 'unknown',
    providerItemId: null,
    reason: 'provider_write_outcome_unknown: timeout',
    submittedAt: 1,
    resolvedAt: 2,
    ...over
  }
}

type ReleaseContext = Parameters<typeof releaseStructuredAgentSessionUnansweredDispatches>[0]
type ReleaseSession = NonNullable<ReturnType<ReleaseContext['sessions']['get']>>
type ResolveDispatchInput = Parameters<ReleaseSession['journal']['resolveDispatch']>[0]

function contextWith(submissions: AgentJournalSubmission[]) {
  const resolved: ResolveDispatchInput[] = []
  const journal = {
    submissions: () => submissions,
    resolveDispatch: vi.fn(async (input: ResolveDispatchInput) => {
      resolved.push(input)
      return { epoch: 'e', sequence: 1 }
    })
  }
  // The mutation reads only `journal.submissions`, `journal.resolveDispatch` and `fence`.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all three are supplied here; the rest of the host session is unreachable from this mutation.
  const session = { journal, fence: FENCE } as unknown as ReleaseSession
  const context: ReleaseContext = { sessions: new Map([['s-1', session]]) }
  return { context, resolved, journal }
}

describe('releasing dispatches the provider can no longer answer', () => {
  it('retires a live unknown so the session stops reading working', async () => {
    const live = [submission({})]
    // POSITIVE CONTROL: this is the latch being dissolved.
    expect(projectStructuredAgentSessionStatus([], live, FENCE)).toBe('working')
    const { context, resolved } = contextWith(live)

    await releaseStructuredAgentSessionUnansweredDispatches(context, {
      sessionId: 's-1',
      reason: 'provider_idle_before_acknowledgement'
    })

    expect(resolved).toEqual([
      {
        clientMessageId: 'm-1',
        state: 'unknown',
        // The sharper earlier fact survives, exactly as restart recovery keeps it.
        reason: 'provider_write_outcome_unknown: timeout',
        fence: FENCE,
        recovered: true
      }
    ])
    expect(projectStructuredAgentSessionStatus([], [submission({ recovered: true })], FENCE)).toBe(
      'idle'
    )
  })

  it('never touches a pending send, whose dispatch may still be in flight', async () => {
    const { context, resolved } = contextWith([
      submission({ clientMessageId: 'm-2', dispatchState: 'pending', reason: null })
    ])

    await releaseStructuredAgentSessionUnansweredDispatches(context, {
      sessionId: 's-1',
      reason: 'provider_idle_before_acknowledgement'
    })

    expect(resolved).toEqual([])
  })

  it('leaves an already recovered unknown alone', async () => {
    const { context, resolved } = contextWith([submission({ recovered: true })])

    await releaseStructuredAgentSessionUnansweredDispatches(context, {
      sessionId: 's-1',
      reason: 'provider_idle_before_acknowledgement'
    })

    expect(resolved).toEqual([])
  })

  it('falls back to the supplied reason when the submission named none', async () => {
    const { context, resolved } = contextWith([submission({ reason: null })])

    await releaseStructuredAgentSessionUnansweredDispatches(context, {
      sessionId: 's-1',
      reason: 'provider_idle_before_acknowledgement'
    })

    expect(resolved[0]).toMatchObject({ reason: 'provider_idle_before_acknowledgement' })
  })
})
