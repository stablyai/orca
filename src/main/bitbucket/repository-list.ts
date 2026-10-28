import type {
  BitbucketRepositoryListResult,
  BitbucketRepositorySummary
} from '../../shared/bitbucket-repositories'
import { escapeBitbucketQueryString, requestJson } from './client'
import { getBitbucketConnectionStatus } from './credential-connection'

export type RawBitbucketRepository = {
  full_name?: string | null
  name?: string | null
  is_private?: boolean | null
  updated_on?: string | null
  links?: { clone?: { name?: string | null; href?: string | null }[] | null } | null
}

// Bitbucket embeds the caller's username in HTTPS clone links; keep the URL shareable.
function stripHttpsUserInfo(href: string): string {
  try {
    const url = new URL(href)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return href
  }
}

// The API now returns ssh.bitbucket.org, but known_hosts and ssh_config entries target bitbucket.org;
// both serve the same host key, and BatchMode clones fail on an unrecorded host name.
function canonicalSshHost(href: string): string {
  return href.replace(/^(ssh:\/\/)?([^@/]+@)?ssh\.bitbucket\.org(?=[:/])/i, '$1$2bitbucket.org')
}

function cloneHref(raw: RawBitbucketRepository, protocol: 'https' | 'ssh'): string | null {
  const href = raw.links?.clone?.find((link) => link.name === protocol)?.href?.trim()
  if (!href) {
    return null
  }
  return protocol === 'https' ? stripHttpsUserInfo(href) : canonicalSshHost(href)
}

export function mapBitbucketRepository(
  raw: RawBitbucketRepository
): BitbucketRepositorySummary | null {
  const fullName = raw.full_name?.trim()
  if (!fullName) {
    return null
  }
  const httpsCloneUrl = cloneHref(raw, 'https')
  const sshCloneUrl = cloneHref(raw, 'ssh')
  if (!httpsCloneUrl && !sshCloneUrl) {
    return null
  }
  return {
    fullName,
    name: raw.name?.trim() || fullName,
    isPrivate: raw.is_private === true,
    updatedOn: raw.updated_on ?? null,
    httpsCloneUrl,
    sshCloneUrl
  }
}

const REPOSITORY_LIST_LIMIT = 50
const WORKSPACE_LIMIT = 20

type RawWorkspaceAccess = { workspace?: { slug?: string | null } | null }

// Bitbucket retired the cross-workspace GET /2.0/repositories (CHANGE-2770); query each workspace.
async function listWorkspaceSlugs(): Promise<string[]> {
  const data = await requestJson<{ values?: RawWorkspaceAccess[] }>(
    '/user/workspaces',
    { searchParams: { pagelen: '100', fields: 'values.workspace.slug' } },
    true
  )
  const slugs = (data?.values ?? []).flatMap((access) => {
    const slug = access.workspace?.slug?.trim()
    return slug ? [slug] : []
  })
  return slugs.slice(0, WORKSPACE_LIMIT)
}

function listWorkspaceRepositories(
  workspace: string,
  search: string
): Promise<{ values?: RawBitbucketRepository[] } | null> {
  const searchParams: Record<string, string> = {
    role: 'member',
    sort: '-updated_on',
    pagelen: String(REPOSITORY_LIST_LIMIT),
    fields: 'values.full_name,values.name,values.is_private,values.updated_on,values.links.clone'
  }
  if (search) {
    searchParams.q = `full_name ~ "${escapeBitbucketQueryString(search)}"`
  }
  return requestJson(`/repositories/${encodeURIComponent(workspace)}`, { searchParams }, true)
}

function byMostRecentlyUpdated(a: BitbucketRepositorySummary, b: BitbucketRepositorySummary) {
  return (b.updatedOn ?? '').localeCompare(a.updatedOn ?? '')
}

export async function listBitbucketRepositories(
  search: string
): Promise<BitbucketRepositoryListResult> {
  // Status reads skip the keychain; requestJson decrypts once for the call itself.
  if (!getBitbucketConnectionStatus().configured) {
    return { ok: false, reason: 'not-configured' }
  }
  try {
    const workspaces = await listWorkspaceSlugs()
    const pages = await Promise.allSettled(
      workspaces.map((workspace) => listWorkspaceRepositories(workspace, search.trim()))
    )
    if (pages.length > 0 && pages.every((page) => page.status === 'rejected')) {
      throw pages[0].reason
    }
    const repositories = pages
      .flatMap((page) => (page.status === 'fulfilled' ? (page.value?.values ?? []) : []))
      .flatMap((raw) => {
        const mapped = mapBitbucketRepository(raw)
        return mapped ? [mapped] : []
      })
      .sort(byMostRecentlyUpdated)
      .slice(0, REPOSITORY_LIST_LIMIT)
    return { ok: true, repositories }
  } catch (error) {
    console.warn('[bitbucket] repository list failed:', error)
    return { ok: false, reason: 'failed' }
  }
}
