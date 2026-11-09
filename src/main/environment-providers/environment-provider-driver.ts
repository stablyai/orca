// One lifecycle seam for VM-backed workspaces: shell recipes, hosted Orca Cloud sandboxes and later
// plugin providers all answer the same calls, and capability flags (not provider ids) drive the UX.
import type { JsonValue } from '../../shared/ephemeral-vm-recipes'

export type EnvironmentProviderCapabilities = Readonly<{
  /** Suspend keeps memory and processes; false means suspend/resume is a reboot from disk. */
  memoryPause: boolean
  /** Hard per-session cap enforced by the provider; null when sessions are unbounded. */
  maxSessionMs: number | null
  /** The filesystem (worktree, auth homes, orcad identity) survives suspend. */
  fsPersistOnStop: boolean
  /** Secrets can be injected at the egress proxy instead of living in the VM. */
  egressInjection: boolean
  /** Orca-owned idle stop; null when the provider has none. */
  idleStopMs: number | null
}>

export type EnvironmentProviderPhase =
  | 'checking-entitlement'
  | 'provisioning'
  | 'booting'
  | 'connecting'
  | 'suspending'
  | 'resuming'
  | 'renewing'
  | 'rolling-over'
  | 'destroying'

export type EnvironmentProviderCallContext = {
  signal?: AbortSignal
  onProgress?: (progress: { phase: EnvironmentProviderPhase; message?: string }) => void
}

export type EnvironmentCreateSpec = {
  /** Orca's workspace id; one environment per workspace. */
  workspaceId: string
  machineSize?: string
  region?: string
  repo?: { url: string; ref?: string }
}

/** Persisted in the runtime record; `driverState` is opaque to everything but the driver. */
export type EnvironmentHandle = {
  driverId: string
  environmentId: string
  driverState: Record<string, JsonValue>
}

export type EnvironmentConnection = {
  type: 'orca-server'
  pairingCode: string
  projectRoot: string
}

export type EnvironmentSessionInfo = {
  startedAt: number
  /** When the provider will end this session regardless of activity. */
  deadlineAt: number | null
  /** When the current Orca lease lapses unless renewed. */
  leaseExpiresAt: number | null
}

export type EnvironmentStatus =
  | 'provisioning'
  | 'running'
  | 'suspending'
  | 'suspended'
  | 'resuming'
  | 'destroying'
  | 'destroyed'
  | 'failed'

export type EnvironmentStatusSnapshot = {
  status: EnvironmentStatus
  session: EnvironmentSessionInfo | null
}

export type EnvironmentReady = {
  handle: EnvironmentHandle
  connection: EnvironmentConnection
  session: EnvironmentSessionInfo
}

export type EnvironmentProviderDriver = {
  readonly id: string
  readonly capabilities: EnvironmentProviderCapabilities
  create(
    spec: EnvironmentCreateSpec,
    ctx?: EnvironmentProviderCallContext
  ): Promise<EnvironmentReady>
  resume(handle: EnvironmentHandle, ctx?: EnvironmentProviderCallContext): Promise<EnvironmentReady>
  suspend(
    handle: EnvironmentHandle,
    ctx?: EnvironmentProviderCallContext
  ): Promise<EnvironmentStatusSnapshot>
  /** Idempotent: an environment that is already gone resolves. */
  destroy(handle: EnvironmentHandle, ctx?: EnvironmentProviderCallContext): Promise<void>
  status(
    handle: EnvironmentHandle,
    ctx?: EnvironmentProviderCallContext
  ): Promise<EnvironmentStatusSnapshot>
  /** Session-capped providers: keep the session alive while Orca reports work. */
  renewLease?(
    handle: EnvironmentHandle,
    extendMs: number,
    ctx?: EnvironmentProviderCallContext
  ): Promise<EnvironmentStatusSnapshot>
  /** Session-capped providers: end this session and start a fresh one from the same disk. */
  rollover?(
    handle: EnvironmentHandle,
    ctx?: EnvironmentProviderCallContext
  ): Promise<EnvironmentReady>
}

export const ENVIRONMENT_PROVIDER_ERROR_CODES = [
  'unauthorized',
  'entitlement_denied',
  'not_found',
  'conflict',
  'invalid_request',
  'unavailable',
  'timeout',
  'aborted',
  'invalid_response'
] as const

export type EnvironmentProviderErrorCode = (typeof ENVIRONMENT_PROVIDER_ERROR_CODES)[number]

export class EnvironmentProviderError extends Error {
  readonly code: EnvironmentProviderErrorCode
  /** Machine-readable detail, e.g. the billing deny reason for `entitlement_denied`. */
  readonly reason: string | null

  constructor(code: EnvironmentProviderErrorCode, message: string, reason: string | null = null) {
    super(message)
    this.name = 'EnvironmentProviderError'
    this.code = code
    this.reason = reason
  }
}

export function isEnvironmentProviderError(
  error: unknown,
  code?: EnvironmentProviderErrorCode
): error is EnvironmentProviderError {
  return error instanceof EnvironmentProviderError && (code === undefined || error.code === code)
}
