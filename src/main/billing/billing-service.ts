import { withCloudBuildDefaults } from '../cloud-build-defaults'
// Plan & billing for the active Orca profile's signed-in account. Results are values, never
// throws, so the renderer can show a precise state. A billing-service refusal never signs the
// user out; only Orca Cloud auth rejecting the session does (via runWithFreshOrcaCloudSession).
import { join } from 'node:path'
import { app } from 'electron'
import type {
  OrcaBillingStatusResult,
  OrcaBillingTeamPlansResult,
  OrcaBillingTrialClaimResult
} from '../../shared/orca-billing'
import type { OrcaPlanCatalogResult } from '../../shared/orca-billing-plans'
import { loadPlanCatalog } from './plan-catalog-client'
import { getOrcaCloudAuthConfig } from '../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { runWithFreshOrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-refresh'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import {
  BillingServiceError,
  claimTrial,
  fetchEntitlement,
  fetchTeamPlans,
  mintBillingToken,
  type BillingEndpoints
} from './billing-client'
import { getBillingEndpoints } from './billing-config'
import { getBillingDevKeyFile, mintDevBillingToken } from './billing-dev-token'
import { cleanCloudServiceUrl } from '../../shared/network/cloud-service-url'
import { listOrcaProfileOrgMembers } from '../orca-profiles/cloud-org/profile-cloud-org-members-service'

type Ready =
  | {
      ok: true
      run: <T>(
        call: (token: string, endpoints: BillingEndpoints) => Promise<T>
      ) => Promise<T | 'signed-out'>
    }
  | { ok: false; status: 'unconfigured' | 'signed-out' }

/** Dev builds with ORCA_BILLING_DEV_KEY_FILE self-sign instead of asking auth (see billing-dev-token). */
function prepareDev(userDataPath: string, keyFile: string): Ready {
  const billingApiUrl = cleanCloudServiceUrl(
    withCloudBuildDefaults(process.env).ORCA_BILLING_API_URL,
    true
  )
  if (!billingApiUrl) {
    return { ok: false, status: 'unconfigured' }
  }
  const active = ensureActiveOrcaProfile(userDataPath)
  const cloud = active.profile.cloud
  if (!cloud) {
    return { ok: false, status: 'signed-out' }
  }
  const endpoints: BillingEndpoints = {
    billingApiUrl,
    billingTokenEndpoint: billingApiUrl
  }
  return {
    ok: true,
    run: async (call) => {
      const orgId = cloud.activeOrgId
      // The roster carries the viewer's live role, as auth's billing-token route would.
      const roster = orgId ? await listOrcaProfileOrgMembers(userDataPath, orgId) : null
      const orgRole = roster?.status === 'ok' ? roster.roster.viewerRole : 'member'
      const token = await mintDevBillingToken(keyFile, {
        userId: cloud.userId,
        email: cloud.email,
        ...(orgId ? { orgId, orgRole } : {})
      })
      return call(token, endpoints)
    }
  }
}

function prepare(userDataPath: string): Ready {
  const devKeyFile = getBillingDevKeyFile(process.env, app.isPackaged)
  if (devKeyFile) {
    return prepareDev(userDataPath, devKeyFile)
  }
  const auth = getOrcaCloudAuthConfig()
  if (!auth.configured) {
    return { ok: false, status: 'unconfigured' }
  }
  const endpoints = getBillingEndpoints(
    auth.config,
    withCloudBuildDefaults(process.env),
    app.isPackaged
  )
  if (!endpoints) {
    return { ok: false, status: 'unconfigured' }
  }
  const active = ensureActiveOrcaProfile(userDataPath)
  if (!active.profile.cloud) {
    return { ok: false, status: 'signed-out' }
  }
  return {
    ok: true,
    run: async (call) => {
      const result = await runWithFreshOrcaCloudSession(
        auth.config,
        active,
        userDataPath,
        async (session) =>
          call(
            // The team this device shows, from the same profile whose session this is (a local
            // profile switch mid-call must not pair one profile's session with another's team);
            // never auth's shared "active team".
            await mintBillingToken(
              endpoints,
              session.accessToken,
              active.profile.cloud?.activeOrgId ?? null
            ),
            endpoints
          )
      )
      return result.status === 'ok' ? result.value : 'signed-out'
    }
  }
}

/**
 * Runs one billing-service call with a fresh billing token for the active profile (cloud setup
 * uses it for its session calls). 'signed-out' when there is no usable Orca session.
 */
export async function withBillingToken<T>(
  userDataPath: string,
  call: (token: string, endpoints: BillingEndpoints) => Promise<T>
): Promise<{ status: 'ok'; value: T } | { status: 'unconfigured' | 'signed-out' }> {
  const ready = prepare(userDataPath)
  if (!ready.ok) {
    return { status: ready.status }
  }
  const value = await ready.run(call)
  return value === 'signed-out' ? { status: 'signed-out' } : { status: 'ok', value }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The billing service origin, without needing a signed-in session (the plan catalog is public). */
function billingApiUrl(): string | null {
  const env = withCloudBuildDefaults(process.env)
  if (getBillingDevKeyFile(process.env, app.isPackaged)) {
    return cleanCloudServiceUrl(env.ORCA_BILLING_API_URL, true) || null
  }
  const auth = getOrcaCloudAuthConfig()
  if (!auth.configured) {
    return null
  }
  return getBillingEndpoints(auth.config, env, app.isPackaged)?.billingApiUrl ?? null
}

/** Billing's public plan catalog (prices from Stripe), with the last good copy for offline. */
export async function getOrcaPlanCatalog(userDataPath: string): Promise<OrcaPlanCatalogResult> {
  const url = billingApiUrl()
  if (!url) {
    return { status: 'unconfigured' }
  }
  try {
    return await loadPlanCatalog({
      billingApiUrl: url,
      cacheFile: join(userDataPath, 'orca-cloud-plan-catalog.json'),
      now: Date.now()
    })
  } catch (error) {
    return { status: 'failed', error: message(error) }
  }
}

export async function getOrcaBillingStatus(userDataPath: string): Promise<OrcaBillingStatusResult> {
  const ready = prepare(userDataPath)
  if (!ready.ok) {
    return { status: ready.status }
  }
  try {
    const entitlement = await ready.run((token, endpoints) => fetchEntitlement(endpoints, token))
    return entitlement === 'signed-out' ? { status: 'signed-out' } : { status: 'ok', entitlement }
  } catch (error) {
    return { status: 'failed', error: message(error) }
  }
}

/** Plan state for other teams the signed-in user is on; never switches teams. */
export async function getOrcaBillingTeamPlans(
  userDataPath: string,
  orgIds: readonly string[]
): Promise<OrcaBillingTeamPlansResult> {
  const ready = prepare(userDataPath)
  if (!ready.ok) {
    return { status: ready.status }
  }
  if (orgIds.length === 0) {
    return { status: 'ok', teams: [] }
  }
  try {
    const teams = await ready.run((token, endpoints) => fetchTeamPlans(endpoints, token, orgIds))
    return teams === 'signed-out' ? { status: 'signed-out' } : { status: 'ok', teams }
  } catch (error) {
    return { status: 'failed', error: message(error) }
  }
}

/** Starts the team's one-time trial (the first time someone on it picks Orca Cloud). Idempotent. */
export async function claimOrcaBillingTrial(
  userDataPath: string
): Promise<OrcaBillingTrialClaimResult> {
  const ready = prepare(userDataPath)
  if (!ready.ok) {
    return { status: ready.status }
  }
  try {
    const entitlement = await ready.run((token, endpoints) => claimTrial(endpoints, token))
    return entitlement === 'signed-out' ? { status: 'signed-out' } : { status: 'ok', entitlement }
  } catch (error) {
    if (error instanceof BillingServiceError) {
      if (error.errorCode === 'trial_unavailable') {
        return { status: 'unavailable' }
      }
      if (error.errorCode === 'team_required') {
        return { status: 'team-required' }
      }
    }
    return { status: 'failed', error: message(error) }
  }
}
