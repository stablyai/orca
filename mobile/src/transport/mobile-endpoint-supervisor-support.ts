import { RelayOuterError } from './mobile-relay-e2ee-link'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { ReplacementAuthenticationTimeoutError } from './replacement-session-authentication'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'

// Why: a suspect session that survived a failed replacement dial must come down,
// else the armed unforced retry dead-ends on needsRecovery seeing stale 'connected'.
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

// Why: a locally-aborted dial (background/stop/missing state) proves nothing about the
// cell assignment, so the director fallback must not burn a resolution round on it.
export class RelayDialAbortedError extends Error {
  constructor() {
    super('relay dial aborted before opening a session')
  }
}

// One credential attempt: dial, and on a director-class failure re-resolve the
// cell assignment, persist it durably, then dial once more.
export async function dialRelayThroughDirectorFallback(args: {
  resumeToken: string
  relay: () => HostProfile['relay']
  dial: () => Promise<RelayDialResult>
  resolveRelay: (input: {
    relay: NonNullable<HostProfile['relay']>
    resumeToken: string
  }) => Promise<MobileRelayEndpoint>
  persistResolvedRelay: (resolved: MobileRelayEndpoint) => Promise<void>
}): Promise<RelayDialResult> {
  const first = await args.dial()
  const relay = args.relay()
  if (
    first.ok ||
    first.error instanceof RelayDialAbortedError ||
    !isDirectorResolutionFailure(first.error) ||
    !relay
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
  // Why: a cell that took relay-auth and went quiet is the right cell working slowly;
  // re-resolving it just doubles the wait against the same contended window.
  if (error instanceof ReplacementAuthenticationTimeoutError) {
    return error.stage === null || error.stage === 'opening'
  }
  return (
    !(error instanceof MobileE2EEAuthenticationError) &&
    (!(error instanceof RelayOuterError) || [4409, 4503, 1006].includes(error.code))
  )
}

/** The relay a supervisor dials; a learned move is persisted as routing, never as a profile. */
export class SupervisedRelayRouting {
  private relay: MobileRelayEndpoint | undefined
  private readonly hostId: string

  constructor(
    host: Pick<HostProfile, 'id' | 'relay'>,
    private readonly dependencies: Pick<MobileEndpointSupervisorDependencies, 'setRelayRouting'>,
    private readonly isStopped: () => boolean
  ) {
    this.relay = host.relay
    this.hostId = host.id
  }

  current(): MobileRelayEndpoint | undefined {
    return this.relay
  }

  async adopt(relay: MobileRelayEndpoint): Promise<void> {
    // Why: a stopped supervisor's host may be removed or re-paired; its successor owns routing.
    if (this.isStopped()) {
      return
    }
    await this.dependencies.setRelayRouting(this.hostId, relay)
    this.relay = relay
  }
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
