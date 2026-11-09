import { withCloudBuildDefaults } from '../cloud-build-defaults'
// Plan & billing for the active Orca profile's signed-in account. Results are values, never
// throws, so the renderer can show a precise state. A billing-service refusal never signs the
// user out; only Orca Cloud auth rejecting the session does (via runWithFreshOrcaCloudSession).
import { app, shell } from 'electron'
import type {
  OrcaBillingCheckoutArgs,
  OrcaBillingOpenResult,
  OrcaBillingOverageArgs,
  OrcaBillingOverageResult,
  OrcaBillingStatusResult
} from '../../shared/orca-billing'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { runWithFreshOrcaCloudSession } from '../orca-profiles/profile-cloud-session-refresh'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import {
  BillingServiceError,
  createCheckoutUrl,
  createPortalUrl,
  fetchEntitlement,
  mintBillingToken,
  updateOverage,
  type BillingEndpoints
} from './billing-client'
import { getBillingEndpoints } from './billing-config'
import { getBillingDevKeyFile, mintDevBillingToken } from './billing-dev-token'
import { cleanCloudServiceUrl } from '../../shared/cloud-service-url'
import { listOrcaProfileOrgMembers } from '../orca-profiles/profile-cloud-org-members-service'

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
  const endpoints: BillingEndpoints = { billingApiUrl, billingTokenEndpoint: billingApiUrl }
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
        async (session) => call(await mintBillingToken(endpoints, session.accessToken), endpoints)
      )
      return result.status === 'ok' ? result.value : 'signed-out'
    }
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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

function openResultForError(error: unknown): OrcaBillingOpenResult {
  if (error instanceof BillingServiceError) {
    if (error.statusCode === 403) {
      return { status: 'forbidden' }
    }
    if (error.errorCode === 'already_subscribed') {
      return { status: 'already-subscribed' }
    }
    if (error.errorCode === 'no_billing_account') {
      return { status: 'no-billing-account' }
    }
  }
  return { status: 'failed', error: message(error) }
}

async function openHosted(
  userDataPath: string,
  createUrl: (token: string, endpoints: BillingEndpoints) => Promise<string>
): Promise<OrcaBillingOpenResult> {
  const ready = prepare(userDataPath)
  if (!ready.ok) {
    return { status: ready.status }
  }
  try {
    const url = await ready.run(createUrl)
    if (url === 'signed-out') {
      return { status: 'signed-out' }
    }
    // createUrl already restricted this to Stripe's hosted Checkout/Portal hosts.
    await shell.openExternal(url)
    return { status: 'opened' }
  } catch (error) {
    return openResultForError(error)
  }
}

export function openOrcaBillingCheckout(
  userDataPath: string,
  args: OrcaBillingCheckoutArgs
): Promise<OrcaBillingOpenResult> {
  return openHosted(userDataPath, (token, endpoints) => createCheckoutUrl(endpoints, token, args))
}

export function openOrcaBillingPortal(userDataPath: string): Promise<OrcaBillingOpenResult> {
  return openHosted(userDataPath, (token, endpoints) => createPortalUrl(endpoints, token))
}

export async function setOrcaBillingOverage(
  userDataPath: string,
  args: OrcaBillingOverageArgs
): Promise<OrcaBillingOverageResult> {
  const ready = prepare(userDataPath)
  if (!ready.ok) {
    return { status: ready.status }
  }
  try {
    const entitlement = await ready.run((token, endpoints) => updateOverage(endpoints, token, args))
    return entitlement === 'signed-out' ? { status: 'signed-out' } : { status: 'ok', entitlement }
  } catch (error) {
    if (error instanceof BillingServiceError) {
      if (error.statusCode === 403) {
        return { status: 'forbidden' }
      }
      if (error.errorCode === 'no_subscription') {
        return { status: 'no-subscription' }
      }
      if (error.errorCode === 'spend_cap_too_high') {
        return { status: 'cap-too-high' }
      }
    }
    return { status: 'failed', error: message(error) }
  }
}
