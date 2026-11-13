import { RelayOuterError } from '../encryption/mobile-relay-e2ee-link'
import { MobileE2EEAuthenticationError } from '../encryption/mobile-e2ee-v2-physical-channel'
import { ReplacementAuthenticationTimeoutError } from './replacement-session-authentication'
import { isHostAttachTimeout } from './relay-recovery-failure-count'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../../src/shared/remote-runtime/relay/mobile-relay-close-codes'
import type { MobileRelayEndpoint } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'

type RelayDialResult = { ok: true } | { ok: false; error: Error }

// Local aborts provide no cell-assignment evidence, so do not consume a director resolution attempt.
export class RelayDialAbortedError extends Error {
  constructor() {
    super('relay dial aborted before opening a session')
  }
}

// An edge that still claims a desktop which moved answers 4404 until its fence lands, so the cell
// alone never reveals the move. Resolve on the second consecutive 4404 (attach timeouts excluded:
// the desktop was seated there), then count afresh so resolves stay at most every other dial.
export class RelayHostOfflineStreak {
  private streak = 0

  shouldResolve(result: RelayDialResult): boolean {
    if (!result.ok && result.error instanceof RelayDialAbortedError) {
      return false
    }
    const hostOffline =
      !result.ok &&
      result.error instanceof RelayOuterError &&
      result.error.code === MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE &&
      !isHostAttachTimeout(result.error)
    this.streak = hostOffline ? this.streak + 1 : 0
    if (this.streak < 2) {
      return false
    }
    this.streak = 0
    return true
  }
}

// After a director-class failure, resolve/persist the assignment and retry this credential once.
export async function dialRelayThroughDirectorFallback(args: {
  resumeToken: string
  hostOfflineStreak?: RelayHostOfflineStreak
  relay: () => MobileRelayEndpoint
  dial: () => Promise<RelayDialResult>
  resolveRelay: (input: {
    relay: MobileRelayEndpoint
    resumeToken: string
  }) => Promise<MobileRelayEndpoint>
  persistResolvedRelay: (resolved: MobileRelayEndpoint) => Promise<void>
}): Promise<RelayDialResult> {
  const first = await args.dial()
  const relay = args.relay()
  const persistentHostOffline = args.hostOfflineStreak?.shouldResolve(first) ?? false
  if (
    first.ok ||
    first.error instanceof RelayDialAbortedError ||
    !(persistentHostOffline || isDirectorResolutionFailure(first.error))
  ) {
    return first
  }
  try {
    const resolved = await args.resolveRelay({ relay, resumeToken: args.resumeToken })
    await args.persistResolvedRelay(resolved)
    return await args.dial()
  } catch (error) {
    return { ok: false, error: toError(error) }
  }
}

export function isDirectorResolutionFailure(error: Error): boolean {
  // Quiet after relay-auth means the assigned cell is slow; resolving it again only doubles the wait.
  if (error instanceof ReplacementAuthenticationTimeoutError) {
    return error.stage === null || error.stage === 'opening'
  }
  return (
    !(error instanceof MobileE2EEAuthenticationError) &&
    (!(error instanceof RelayOuterError) || [4409, 4503, 1006].includes(error.code))
  )
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
