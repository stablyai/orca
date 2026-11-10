import { RelayOuterError } from '../encryption/mobile-relay-e2ee-link'
import { MobileE2EEAuthenticationError } from '../encryption/mobile-e2ee-v2-physical-channel'
import { ReplacementAuthenticationTimeoutError } from './replacement-session-authentication'
import type { MobileRelayEndpoint } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'

type RelayDialResult = { ok: true } | { ok: false; error: Error }

// Local aborts provide no cell-assignment evidence, so do not consume a director resolution attempt.
export class RelayDialAbortedError extends Error {
  constructor() {
    super('relay dial aborted before opening a session')
  }
}

// After a director-class failure, resolve/persist the assignment and retry this credential once.
export async function dialRelayThroughDirectorFallback(args: {
  resumeToken: string
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
  if (
    first.ok ||
    first.error instanceof RelayDialAbortedError ||
    !isDirectorResolutionFailure(first.error)
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
