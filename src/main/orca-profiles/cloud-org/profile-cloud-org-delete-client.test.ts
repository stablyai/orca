import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import {
  checkOrcaCloudOrgDelete,
  deleteOrcaCloudOrg,
  parseOrgDeleteCheck
} from './profile-cloud-org-delete-client'
import { mapOrgDeleteRequestError } from './profile-cloud-org-delete-service'

const base = 'https://auth.test'
const config: OrcaCloudAuthConfig = {
  apiBaseUrl: base,
  authorizeEndpoint: `${base}/a`,
  sessionEndpoint: `${base}/s`,
  refreshEndpoint: `${base}/r`,
  capabilitiesEndpoint: `${base}/c`,
  profileEndpoint: `${base}/p`,
  orgEndpoint: `${base}/o`,
  logoutEndpoint: `${base}/l`,
  relayTokenEndpoint: `${base}/rt`,
  connectorTokenEndpoint: `${base}/ct`,
  relayDirectorUrl: base,
  clientId: 'orca-desktop',
  scope: 'openid'
}
const session: OrcaCloudSession = {
  accessToken: 'token',
  refreshToken: 'refresh',
  expiresAt: 4_102_444_800_000,
  capabilities: { flags: {}, refreshedAt: 0 }
}

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('team delete client (TEAM-DELETE)', () => {
  it('reads the pre-check, keeping known blockers only', async () => {
    respond(200, {
      deletable: false,
      blockers: [
        { code: 'subscription_active', status: 'trialing' },
        { code: 'workspaces_exist', count: 3 },
        { code: 'something_new' }
      ]
    })
    await expect(checkOrcaCloudOrgDelete(config, session, 'org_1')).resolves.toEqual({
      deletable: false,
      blockers: [
        { code: 'subscription_active', status: 'trialing' },
        { code: 'workspaces_exist', count: 3 }
      ]
    })
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      `${base}/v1/desktop/orgs/org_1/delete-check?supports=cancel_on_delete`
    )
  })

  it('never calls a team deletable while a known blocker is listed', () => {
    expect(
      parseOrgDeleteCheck({ deletable: true, blockers: [{ code: 'workspaces_exist', count: 1 }] })
        .deletable
    ).toBe(false)
  })

  it('sends the typed name as is and reads 409 not_deletable as blocked', async () => {
    respond(409, { error: 'not_deletable', blockers: [{ code: 'workspaces_exist', count: 1 }] })
    await expect(
      deleteOrcaCloudOrg(config, session, { orgId: 'org_1', confirmName: ' Acme ' })
    ).resolves.toEqual({ kind: 'blocked', blockers: [{ code: 'workspaces_exist', count: 1 }] })
    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    expect(init?.body).toBe(JSON.stringify({ confirmName: ' Acme ' }))
    expect(init?.redirect).toBe('error')
  })

  it('throws other failures with their code, and maps them', async () => {
    respond(400, { error: 'confirm_mismatch' })
    const error = await deleteOrcaCloudOrg(config, session, {
      orgId: 'org_1',
      confirmName: 'x'
    }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(OrcaCloudRequestError)
    expect(mapOrgDeleteRequestError(new OrcaCloudRequestError(503, 'billing_unavailable'))).toEqual(
      { status: 'unavailable' }
    )
    expect(mapOrgDeleteRequestError(new OrcaCloudRequestError(429, 'rate_limited'))).toEqual({
      status: 'rate-limited'
    })
    expect(mapOrgDeleteRequestError(new OrcaCloudRequestError(403, 'not_owner'))).toEqual({
      status: 'forbidden'
    })
    // No JSON code on a 404: this auth predates team delete.
    expect(mapOrgDeleteRequestError(new OrcaCloudRequestError(404))).toEqual({
      status: 'unsupported'
    })
  })

  it('EP-10: reads a cancelling plan the delete ends now, and ignores a malformed one', async () => {
    respond(200, {
      deletable: true,
      blockers: [],
      cancelsSubscription: { periodEnd: '2026-12-01T00:00:00.000Z' }
    })
    await expect(checkOrcaCloudOrgDelete(config, session, 'org_1')).resolves.toEqual({
      deletable: true,
      blockers: [],
      cancelsSubscription: { periodEnd: '2026-12-01T00:00:00.000Z' }
    })
    expect(
      parseOrgDeleteCheck({
        deletable: true,
        blockers: [],
        cancelsSubscription: { periodEnd: 'soon' }
      })
    ).toEqual({ deletable: true, blockers: [] })
  })

  it('EP-10: a delete that failed after the plan ended says so, whatever its status', async () => {
    respond(503, { error: 'delete_failed_after_cancel', cause: 'sandbox_control_unavailable' })
    await expect(
      deleteOrcaCloudOrg(config, session, { orgId: 'org_1', confirmName: 'Acme' })
    ).resolves.toEqual({ kind: 'failed-after-cancel', cause: 'sandbox_control_unavailable' })
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      `${base}/v1/desktop/orgs/org_1/delete?supports=cancel_on_delete`
    )
    respond(409, {
      error: 'delete_failed_after_cancel',
      cause: 'not_deletable',
      blockers: [{ code: 'workspaces_exist', count: 1 }]
    })
    await expect(
      deleteOrcaCloudOrg(config, session, { orgId: 'org_1', confirmName: 'Acme' })
    ).resolves.toEqual({ kind: 'failed-after-cancel', cause: 'not_deletable' })
  })

  it('EP-10: billing could not end the plan: blocked, team and plan untouched', async () => {
    respond(409, {
      error: 'not_deletable',
      blockers: [{ code: 'subscription_active', status: 'cancelling' }]
    })
    await expect(
      deleteOrcaCloudOrg(config, session, { orgId: 'org_1', confirmName: 'Acme' })
    ).resolves.toEqual({
      kind: 'blocked',
      blockers: [{ code: 'subscription_active', status: 'cancelling' }]
    })
  })
})
