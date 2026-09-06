import type { MobileWebBridgeShellMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type {
  MobileWebBridgeCapability,
  MobileWebBridgeOperationName
} from '../../../src/shared/mobile-web/bridge-operation-registry'

export type MobileWebOperationGrant = Extract<
  MobileWebBridgeShellMessage,
  { type: 'init' }
>['grants'][number]

export type MobileWebOperationGrantLimits = MobileWebOperationGrant['limits']

/** Per-operation budget, in declaration order: request bytes, response bytes, concurrent requests,
 * rate-limiter bucket capacity, bucket refill per second. */
export function grantLimits(
  maxRequestBytes: number,
  maxResponseBytes: number,
  maxConcurrent: number,
  rateCapacity: number,
  rateRefillPerSecond: number
): MobileWebOperationGrantLimits {
  return {
    maxRequestBytes,
    maxResponseBytes,
    maxConcurrent,
    rateCapacity,
    rateRefillPerSecond
  }
}

/** Grants for one capability, keyed by operation name so a typo or a retired operation is a
 * compile error rather than a grant the shell silently never matches. */
export function capabilityGrants<TCapability extends MobileWebBridgeCapability>(
  capability: TCapability,
  operations: Partial<
    Record<MobileWebBridgeOperationName<TCapability>, MobileWebOperationGrantLimits>
  >
): readonly MobileWebOperationGrant[] {
  return Object.entries(operations).map(([operation, limits]) => ({
    capability,
    operation,
    limits: limits as MobileWebOperationGrantLimits
  }))
}

/** Grants indexed by `capability.operation`. The broker resolves one per request, including every
 * terminal keystroke, so a linear scan of all 226 entries is not an option. */
export function indexGrants(
  grants: readonly MobileWebOperationGrant[]
): ReadonlyMap<string, MobileWebOperationGrant> {
  return new Map(grants.map((grant) => [`${grant.capability}.${grant.operation}`, grant]))
}
