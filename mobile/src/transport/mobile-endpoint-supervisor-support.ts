import { RelayOuterError } from './mobile-relay-e2ee-link'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { ReplacementAuthenticationTimeoutError } from './replacement-session-authentication'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'

// Retire a suspect session after failed replacement or stale connected state blocks the armed recovery retry.
export function suspendRelayIfStillConnected(
  controller: RelayReconnectController,
  logical: StableLogicalRpcClient
): void {
  if (logical.getState() === 'connected') {
    controller.suspendActiveRelay(logical)
  }
}

export function liveRelayLeaseExpiry(
  logical: StableLogicalRpcClient,
  stopped: boolean,
  expiry: number | null
): number | null {
  return !stopped && logical.getActivePath() === 'relay' && logical.getState() === 'connected'
    ? expiry
    : null
}

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

export function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
