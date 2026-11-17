import type {
  OrcaOrgMember,
  OrcaOrgMembersRoster,
  OrcaOrgPendingInvite,
  OrcaOrgRole
} from '../../../shared/orca-profiles/orca-profiles'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import { cloudOrgMemberFields } from './profile-cloud-org-member-cloud-fields'

const CLOUD_REQUEST_TIMEOUT_MS = 30_000
const ORG_ROLES: readonly OrcaOrgRole[] = ['owner', 'admin', 'member']

function isOrgRole(value: unknown): value is OrcaOrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value)
}

function normalizeRole(value: unknown, fallback: OrcaOrgRole): OrcaOrgRole {
  return isOrgRole(value) ? value : fallback
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return Date.now()
}

function normalizeMember(value: unknown): OrcaOrgMember | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const email = optionalString(record.email)
  if (!email) {
    return null
  }
  const userId = optionalString(record.userId)
  return {
    userId: userId ?? null,
    email,
    displayName: optionalString(record.displayName),
    role: normalizeRole(record.role, 'member'),
    ...cloudOrgMemberFields(record)
  }
}

function normalizePendingInvite(value: unknown): OrcaOrgPendingInvite | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const email = optionalString(record.email)
  if (!email) {
    return null
  }
  return {
    email,
    role: normalizeRole(record.role, 'member'),
    createdAt: normalizeTimestamp(record.createdAt)
  }
}

export function normalizeRoster(value: unknown): OrcaOrgMembersRoster {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid_orca_org_members_roster')
  }
  const record = value as Record<string, unknown>
  const members = Array.isArray(record.members)
    ? record.members
        .map(normalizeMember)
        .filter((member): member is OrcaOrgMember => member !== null)
    : []
  const pendingInvites = Array.isArray(record.pendingInvites)
    ? record.pendingInvites
        .map(normalizePendingInvite)
        .filter((invite): invite is OrcaOrgPendingInvite => invite !== null)
    : []
  return {
    members,
    pendingInvites,
    // Malformed roles must not widen UI permissions; the server still authorizes mutations.
    viewerRole: normalizeRole(record.viewerRole, 'member'),
    canManageMembers: record.canManageMembers === true,
    ...(record.directoryManaged === true ? { directoryManaged: true } : {})
  }
}

export function orgMembersUrl(config: OrcaCloudAuthConfig, orgId: string, path: string): string {
  return `${config.apiBaseUrl}/v1/desktop/orgs/${encodeURIComponent(orgId)}${path}`
}

export async function extractErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as unknown
    if (
      body &&
      typeof body === 'object' &&
      typeof (body as { error?: unknown }).error === 'string'
    ) {
      return (body as { error: string }).error.trim() || undefined
    }
  } catch {
    // The status code suffices when error bodies are not JSON.
  }
  return undefined
}

// Reject redirects to avoid leaking access tokens; timeouts bound renderer IPC waits.
export function requestInit(
  method: 'GET' | 'POST',
  accessToken: string,
  body?: unknown
): RequestInit {
  return {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${accessToken}`
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS)
  }
}

async function requestOrgMembers<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => T
): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, await extractErrorCode(response))
  }
  return parse((await response.json()) as unknown)
}

export async function listOrcaCloudOrgMembers(
  config: OrcaCloudAuthConfig,
  session: OrcaCloudSession,
  orgId: string
): Promise<OrcaOrgMembersRoster> {
  return requestOrgMembers(
    orgMembersUrl(config, orgId, '/members'),
    requestInit('GET', session.accessToken),
    normalizeRoster
  )
}
