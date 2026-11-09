// After a rollover, carry on the agents the drain interrupted, through the same host restart offers
// the "Resume chats" prompt uses (agentSession.restartResumable → agentSession.restartContinue).
// Only offers recorded by this drain are continued; older offers stay for the user to decide.
import { z } from 'zod'
import { MAX_RESTART_RESUME_SESSIONS } from '../../shared/rpc-contract/structured-agent-session-params'

export type RuntimeCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export type HostedAgentAutoResumeOutcome = {
  offered: number
  continued: number
  skipped: number
  /** True when the host has no restart-offer support; nothing was sent. */
  unsupported: boolean
}

// The host is the single writer of these shapes; rows this side cannot read are left alone.
const OfferList = z.looseObject({
  sessions: z.array(z.unknown())
})
const Offer = z.looseObject({ sessionId: z.string(), recordedAt: z.number() })
const ContinueAnswer = z.looseObject({
  continued: z.array(z.unknown()).optional(),
  skipped: z.array(z.unknown()).optional()
})

/** `recordedAt` is the host's clock and `drainStartedAt` this machine's: tolerate skew between
 *  them so an offer the drain just recorded is not mistaken for an older one. */
export const CLOCK_SKEW_TOLERANCE_MS = 2 * 60_000

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export async function autoResumeAgentsAfterRollover(
  call: RuntimeCall,
  drainStartedAt: number
): Promise<HostedAgentAutoResumeOutcome> {
  let listed: unknown
  try {
    listed = await call('agentSession.restartResumable')
  } catch (error) {
    if (hasCode(error, 'method_not_found')) {
      return { offered: 0, continued: 0, skipped: 0, unsupported: true }
    }
    throw error
  }
  const list = OfferList.safeParse(listed)
  if (!list.success) {
    throw new Error('agent_session_restart_offer_invalid')
  }
  const ids = list.data.sessions.flatMap((row) => {
    const offer = Offer.safeParse(row)
    return offer.success && offer.data.recordedAt >= drainStartedAt - CLOCK_SKEW_TOLERANCE_MS
      ? [offer.data.sessionId]
      : []
  })
  const outcome = { offered: ids.length, continued: 0, skipped: 0, unsupported: false }
  for (let offset = 0; offset < ids.length; offset += MAX_RESTART_RESUME_SESSIONS) {
    const answer = await call('agentSession.restartContinue', {
      sessionIds: ids.slice(offset, offset + MAX_RESTART_RESUME_SESSIONS)
    })
    const counted = ContinueAnswer.safeParse(answer)
    outcome.continued += counted.success ? (counted.data.continued?.length ?? 0) : 0
    outcome.skipped += counted.success ? (counted.data.skipped?.length ?? 0) : 0
  }
  return outcome
}
