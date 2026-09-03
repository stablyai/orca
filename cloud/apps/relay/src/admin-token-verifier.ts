import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { RelayConfig } from './config.js'

export const RELAY_MONITOR_ADMIN_ROUTES = [
  '/v1/admin/admission-selector/status',
  '/v1/admin/cell-status',
  '/v1/admin/evacuation-status',
  '/v1/admin/regional-rehome-control',
  '/v1/admin/runtime-status'
] as const

export const RELAY_FENCE_ADMIN_ROUTES = [
  ...RELAY_MONITOR_ADMIN_ROUTES,
  '/v1/admin/evacuation-capacity',
  '/v1/admin/cell-fence-attempt-status'
] as const

export const RELAY_CAPACITY_ADMIN_ROUTES = [
  '/v1/admin/admission-selector/status',
  '/v1/admin/admission-selector/apply',
  '/v1/admin/cell-state',
  '/v1/admin/cell-status',
  '/v1/admin/runtime-status',
  '/v1/admin/drain'
] as const

export const RELAY_ASIA_PROOF_ADMIN_ROUTES = [
  '/v1/admin/admission-selector/status',
  '/v1/admin/admission-selector/apply-staging-asia-proof',
  '/v1/admin/cell-status',
  '/v1/admin/runtime-status'
] as const

export const RELAY_FENCE_BROKER_ADMIN_ROUTES = [
  ...RELAY_FENCE_ADMIN_ROUTES,
  '/v1/admin/cell-fence-adopt-legacy',
  '/v1/admin/cell-fence-commit-legacy-adoption',
  '/v1/admin/cell-fence-attest',
  '/v1/admin/cell-fence-attempt-prepare',
  '/v1/admin/cell-fence-attempt-start',
  '/v1/admin/cell-fence-attempt-plan',
  '/v1/admin/cell-fence-attempt-operation',
  '/v1/admin/cell-fence-attempt-abort',
  '/v1/admin/migration-supersede-cell'
] as const

type RelayAdminIdentity =
  | 'deploy'
  | 'capacity'
  | 'asia-proof'
  | 'monitor'
  | 'fence'
  | 'fence-broker'

function createGoogleServiceTokenVerifier(input: {
  jwksUrl: string
  audience: string
  serviceAccount: string
}): (token: string) => Promise<boolean> {
  const jwks = createRemoteJWKSet(new URL(input.jwksUrl))
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: input.audience,
        algorithms: ['RS256']
      })
      return payload.email === input.serviceAccount && payload.email_verified === true
    } catch {
      return false
    }
  }
}

function createGoogleServiceTokenIdentityVerifier(input: {
  jwksUrl: string
  audience: string
  serviceAccounts: ReadonlyMap<string, RelayAdminIdentity>
}): (token: string) => Promise<RelayAdminIdentity | null> {
  const jwks = createRemoteJWKSet(new URL(input.jwksUrl))
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: input.audience,
        algorithms: ['RS256']
      })
      if (payload.email_verified !== true || typeof payload.email !== 'string') return null
      return input.serviceAccounts.get(payload.email) ?? null
    } catch {
      return null
    }
  }
}

export function relayAdminIdentityMayAccess(
  identity: RelayAdminIdentity,
  route: string
): boolean {
  if (identity === 'deploy') return route.startsWith('/v1/admin/')
  if (identity === 'capacity') {
    return (RELAY_CAPACITY_ADMIN_ROUTES as readonly string[]).includes(route)
  }
  if (identity === 'asia-proof') {
    return (RELAY_ASIA_PROOF_ADMIN_ROUTES as readonly string[]).includes(route)
  }
  if (identity === 'monitor') {
    return (RELAY_MONITOR_ADMIN_ROUTES as readonly string[]).includes(route)
  }
  if (identity === 'fence') {
    return (RELAY_FENCE_ADMIN_ROUTES as readonly string[]).includes(route)
  }
  return (RELAY_FENCE_BROKER_ADMIN_ROUTES as readonly string[]).includes(route)
}

export function createReadOnlyAdminTokenVerifier(
  config: RelayConfig
): (token: string) => Promise<boolean> {
  const serviceAccounts = new Map<string, RelayAdminIdentity>()
  if (config.monitorServiceAccount) serviceAccounts.set(config.monitorServiceAccount, 'monitor')
  if (config.fenceServiceAccount) serviceAccounts.set(config.fenceServiceAccount, 'fence')
  if (serviceAccounts.size === 0) return async () => false
  const verifyIdentity = createGoogleServiceTokenIdentityVerifier({
    jwksUrl: config.adminJwksUrl,
    audience: config.adminAudience,
    serviceAccounts
  })
  return async (token) => (await verifyIdentity(token)) !== null
}

export function createAdminTokenVerifier(
  config: RelayConfig
): (token: string, route?: string) => Promise<boolean> {
  const serviceAccounts = new Map<string, RelayAdminIdentity>([
    [config.deployServiceAccount, 'deploy']
  ])
  if (config.capacityServiceAccount) {
    serviceAccounts.set(config.capacityServiceAccount, 'capacity')
  }
  if (config.asiaProofServiceAccount) {
    serviceAccounts.set(config.asiaProofServiceAccount, 'asia-proof')
  }
  if (config.monitorServiceAccount) serviceAccounts.set(config.monitorServiceAccount, 'monitor')
  if (config.fenceServiceAccount) serviceAccounts.set(config.fenceServiceAccount, 'fence')
  if (config.fenceBrokerServiceAccount) {
    serviceAccounts.set(config.fenceBrokerServiceAccount, 'fence-broker')
  }
  const verifyIdentity = createGoogleServiceTokenIdentityVerifier({
    jwksUrl: config.adminJwksUrl,
    audience: config.adminAudience,
    serviceAccounts
  })
  return async (token, route) => {
    const identity = await verifyIdentity(token)
    return identity !== null && (!route || relayAdminIdentityMayAccess(identity, route))
  }
}

export function createRegionalRehomeControlApplyTokenVerifier(
  config: RelayConfig
): (token: string) => Promise<boolean> {
  return createGoogleServiceTokenVerifier({
    jwksUrl: config.adminJwksUrl,
    audience: config.adminAudience,
    serviceAccount: config.deployServiceAccount
  })
}

export function createRuntimeTokenVerifier(
  config: RelayConfig
): (token: string) => Promise<boolean> {
  if (!config.heartbeatAudience) return async () => false
  return createGoogleServiceTokenVerifier({
    jwksUrl: config.adminJwksUrl,
    audience: config.heartbeatAudience,
    serviceAccount: config.runtimeServiceAccount
  })
}

export function createRegionalRehomeTokenVerifier(
  config: RelayConfig
): (token: string) => Promise<boolean> {
  if (!config.rehomeAudience || !config.rehomeDirectorServiceAccount) {
    return async () => false
  }
  return createGoogleServiceTokenVerifier({
    jwksUrl: config.adminJwksUrl,
    audience: config.rehomeAudience,
    serviceAccount: config.rehomeDirectorServiceAccount
  })
}

export function createRegionalRehomeRuntimeTokenVerifier(
  config: RelayConfig
): (token: string) => Promise<boolean> {
  if (!config.rehomeAudience) return async () => false
  return createGoogleServiceTokenVerifier({
    jwksUrl: config.adminJwksUrl,
    audience: config.rehomeAudience,
    serviceAccount: config.runtimeServiceAccount
  })
}
