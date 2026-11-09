// Orca Cloud's additions on top of the upstream EnvironmentProviderDriver: a lease on a capped
// session, rollover onto the same disk, egress-injected secrets and plan entitlement denials.
import {
  EnvironmentProviderError,
  type EnvironmentHandle,
  type EnvironmentProviderCallContext,
  type EnvironmentProviderCapabilities,
  type EnvironmentProviderDriver,
  type EnvironmentReady,
  type EnvironmentSessionInfo,
  type EnvironmentStatus
} from '../environment-providers/environment-provider-driver'

export type HostedEnvironmentCapabilities = EnvironmentProviderCapabilities &
  Readonly<{
    /** Secrets can be injected at the egress proxy instead of living in the VM. */
    egressInjection: boolean
  }>

export type HostedSessionInfo = EnvironmentSessionInfo & {
  /** When the current Orca lease lapses unless renewed. */
  leaseExpiresAt: number | null
}

export type HostedStatusSnapshot = {
  status: EnvironmentStatus
  session: HostedSessionInfo | null
}

export type HostedEnvironmentReady = EnvironmentReady & { session: HostedSessionInfo }

// Narrows the upstream return types; still assignable wherever an EnvironmentProviderDriver is expected.
export type HostedEnvironmentProviderDriver = Omit<
  EnvironmentProviderDriver,
  'capabilities' | 'create' | 'resume' | 'suspend' | 'status'
> & {
  readonly capabilities: HostedEnvironmentCapabilities
  create(...args: Parameters<EnvironmentProviderDriver['create']>): Promise<HostedEnvironmentReady>
  resume(
    handle: EnvironmentHandle,
    ctx?: EnvironmentProviderCallContext
  ): Promise<HostedEnvironmentReady>
  suspend(
    handle: EnvironmentHandle,
    ctx?: EnvironmentProviderCallContext
  ): Promise<HostedStatusSnapshot>
  status(
    handle: EnvironmentHandle,
    ctx?: EnvironmentProviderCallContext
  ): Promise<HostedStatusSnapshot>
  /** Keep the capped session alive while Orca reports work. */
  renewLease(
    handle: EnvironmentHandle,
    extendMs: number,
    ctx?: EnvironmentProviderCallContext
  ): Promise<HostedStatusSnapshot>
  /** End this session and start a fresh one from the same disk. */
  rollover(
    handle: EnvironmentHandle,
    ctx?: EnvironmentProviderCallContext
  ): Promise<HostedEnvironmentReady>
}

/** The plan refused the start; `reason` is the billing deny reason. Reads as `unauthorized` generically. */
export class HostedEntitlementDeniedError extends EnvironmentProviderError {
  constructor(message: string, reason: string | null) {
    super('unauthorized', message, reason)
    this.name = 'HostedEntitlementDeniedError'
  }
}

export function isHostedEntitlementDenied(error: unknown): error is HostedEntitlementDeniedError {
  return error instanceof HostedEntitlementDeniedError
}
