import { randomUUID } from 'node:crypto'
import type { MCodeCloudCapabilities, MCodeCloudOrgSummary } from '../../shared/mcode-profiles'
import type { MCodeCloudSessionExchangeResponse } from './profile-cloud-session-exchange'

const DEV_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

function cleanEnvString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

function defaultDevOrganizations(): MCodeCloudOrgSummary[] {
  return [
    { orgId: 'dev-personal', name: 'Personal', role: 'Owner' },
    { orgId: 'dev-acme', name: 'Acme Dev', role: 'Admin' }
  ]
}

function devCapabilities(): MCodeCloudCapabilities {
  return {
    flags: {
      share: true,
      team: true,
      'share.create': true,
      'share.manage': true,
      'relay.use': true,
      'team.member': true,
      'enterprise.sso': true
    },
    refreshedAt: Date.now()
  }
}

function devToken(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

export function createDevMCodeCloudSession(
  args: {
    localProfileId?: string
    cloudProfileId?: string
    orgId?: string
  } = {}
): MCodeCloudSessionExchangeResponse {
  const organizations = defaultDevOrganizations()
  const selectedOrg = organizations.find((organization) => organization.orgId === args.orgId)
  const cloudProfileId =
    args.cloudProfileId ??
    (args.localProfileId ? `dev-cloud-${args.localProfileId}` : `dev-cloud-${randomUUID()}`)

  return {
    accessToken: devToken('dev-access'),
    refreshToken: devToken('dev-refresh'),
    expiresAt: Date.now() + DEV_SESSION_TTL_MS,
    cloud: {
      cloudProfileId,
      userId: cleanEnvString(process.env.MCODE_CLOUD_DEV_USER_ID, 'dev-user'),
      email: cleanEnvString(process.env.MCODE_CLOUD_DEV_EMAIL, 'dev@mcode.local'),
      displayName: cleanEnvString(process.env.MCODE_CLOUD_DEV_DISPLAY_NAME, 'MCode Dev'),
      activeOrgId: selectedOrg?.orgId,
      activeOrgName: selectedOrg?.name,
      linkedAt: Date.now()
    },
    organizations,
    capabilities: devCapabilities()
  }
}
