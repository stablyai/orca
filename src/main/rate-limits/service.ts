import { RateLimitServiceConfiguration } from './service/service-configuration'

export type { InactiveCodexAccountInfo } from './service/service-types'

/**
 * Coordinates provider quota polling and publishes a stable rate-limit snapshot.
 * The implementation is layered by lifecycle, account selection, and fetch policy
 * so each module stays small while this path remains the public integration seam.
 */
export class RateLimitService extends RateLimitServiceConfiguration {}
