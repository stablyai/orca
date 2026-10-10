import type { ListAccessibleProjectsArgs } from '../../../shared/github/project-request-types'
import type { ListAccessibleProjectsResult } from '../../../shared/github/project-result-types'
import type {
  GitHubProjectOwnerType,
  GitHubProjectSummary
} from '../../../shared/github/project-types'
import { githubProjectHost } from '../../../shared/github/project-identity'
import { projectGhExecOptions, runGraphql, type GraphqlVars } from './internals'
import { driftError } from './project-error-classification'
import { rememberOwnerType } from './project-view-cache'

// ─── Constants ─────────────────────────────────────────────────────────

// Why: defaults deliberately shrunk to cut quota spend in discovery — the org loop dominates and produced the HTTP 504; overflow owners can paste a URL.
const DISCOVERY_PROJECTS_PER_OWNER = 40
const DISCOVERY_MAX_ORGS = 20
const DISCOVERY_ORG_PAGE_SIZE = 20
const DISCOVERY_PROJECTS_PER_ORG = 20

type RawViewerDiscovery = {
  viewer?: {
    login?: string
    projectsV2?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      nodes?: ({
        id?: string
        number?: number
        title?: string
        url?: string
        owner?: { __typename?: string; login?: string }
      } | null)[]
    }
    organizations?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      nodes?: ({
        login?: string
        projectsV2?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
          nodes?: ({ id?: string; number?: number; title?: string; url?: string } | null)[]
        }
      } | null)[]
    }
  }
}

// ─── listAccessibleProjects ────────────────────────────────────────────

export async function listAccessibleProjects(
  args?: ListAccessibleProjectsArgs
): Promise<ListAccessibleProjectsResult> {
  const host = githubProjectHost(args?.host)
  const viewerProjects: GitHubProjectSummary[] = []
  const orgProjects: GitHubProjectSummary[] = []
  // Why: collect per-org failures so the picker shows a "some orgs didn't load" banner instead of aborting discovery on the first 504.
  const partialFailures: { owner: string; message: string }[] = []
  let viewerLogin: string | null = null

  // 1) Viewer projects (paginated, single owner so cap at DISCOVERY_PROJECTS_PER_OWNER total).
  let viewerCursor: string | null = null
  let viewerMore = true
  let viewerFetched = 0
  while (viewerMore && viewerFetched < DISCOVERY_PROJECTS_PER_OWNER) {
    const afterArg = viewerCursor ? ', after: $after' : ''
    const afterVar = viewerCursor ? '$after:String!' : ''
    const query = `
      query${afterVar ? `(${afterVar})` : ''} {
        viewer {
          login
          projectsV2(first:${DISCOVERY_PROJECTS_PER_ORG}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id number title url
              owner { __typename ... on Organization { login } ... on User { login } }
            }
          }
        }
      }
    `
    const vars: GraphqlVars = {}
    if (viewerCursor) {
      vars.after = viewerCursor
    }
    const res = await runGraphql<RawViewerDiscovery>(query, vars, projectGhExecOptions(host))
    if (!res.ok) {
      // Why: viewer-level failure is structural (no projects to build on), so propagate hard; org-level errors below are non-fatal.
      return { ok: false, error: res.error }
    }
    if (!res.data.viewer) {
      return { ok: false, error: driftError('viewer missing') }
    }
    if (viewerLogin === null) {
      viewerLogin = res.data.viewer.login ?? null
    }
    const nodes = res.data.viewer.projectsV2?.nodes ?? []
    for (const n of nodes) {
      if (!n || typeof n.id !== 'string' || typeof n.number !== 'number') {
        continue
      }
      const ownerLogin = n.owner?.login ?? viewerLogin ?? ''
      const ownerType: GitHubProjectOwnerType =
        n.owner?.__typename === 'Organization' ? 'organization' : 'user'
      viewerProjects.push({
        id: n.id,
        host,
        owner: ownerLogin,
        ownerType,
        number: n.number,
        title: n.title ?? '',
        url: n.url ?? '',
        source: 'viewer'
      })
      viewerFetched++
      if (viewerFetched >= DISCOVERY_PROJECTS_PER_OWNER) {
        break
      }
    }
    const pi = res.data.viewer.projectsV2?.pageInfo
    viewerMore = pi?.hasNextPage === true && typeof pi.endCursor === 'string'
    viewerCursor = viewerMore ? (pi?.endCursor ?? null) : null
  }

  // 2) Organizations the viewer belongs to, each with its projectsV2.
  // Why: no per-org projectsV2 continuation loop — it was the dominant 504 cost; users past the cap can paste a URL instead.
  let orgCursor: string | null = null
  let orgMore = true
  let orgsSeen = 0
  while (orgMore && orgsSeen < DISCOVERY_MAX_ORGS) {
    const afterArg = orgCursor ? ', after: $orgAfter' : ''
    const afterVar = orgCursor ? '$orgAfter:String!' : ''
    const query = `
      query${afterVar ? `(${afterVar})` : ''} {
        viewer {
          organizations(first:${DISCOVERY_ORG_PAGE_SIZE}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              login
              projectsV2(first:${DISCOVERY_PROJECTS_PER_ORG}) {
                pageInfo { hasNextPage endCursor }
                nodes { id number title url }
              }
            }
          }
        }
      }
    `
    const vars: GraphqlVars = {}
    if (orgCursor) {
      vars.orgAfter = orgCursor
    }
    const res = await runGraphql<RawViewerDiscovery>(query, vars, projectGhExecOptions(host))
    if (!res.ok) {
      // Why: org-listing failed; record a synthetic '*' partial failure so the banner explains it, but keep collected viewer projects (the reported 504 path).
      partialFailures.push({ owner: '*', message: res.error.message })
      break
    }
    const orgs = res.data.viewer?.organizations?.nodes ?? []
    for (const org of orgs) {
      if (!org || typeof org.login !== 'string') {
        continue
      }
      if (orgsSeen >= DISCOVERY_MAX_ORGS) {
        break
      }
      orgsSeen++
      const login = org.login
      // Cache for paste/resolve even when the nested projects query was empty or partially failed.
      rememberOwnerType(login, 'organization', host)
      const nodes = org.projectsV2?.nodes ?? []
      let ownerCount = 0
      for (const n of nodes) {
        if (!n || typeof n.id !== 'string' || typeof n.number !== 'number') {
          continue
        }
        if (ownerCount >= DISCOVERY_PROJECTS_PER_OWNER) {
          break
        }
        orgProjects.push({
          id: n.id,
          host,
          owner: login,
          ownerType: 'organization',
          number: n.number,
          title: n.title ?? '',
          url: n.url ?? '',
          source: `org:${login}`
        })
        ownerCount++
      }
    }
    const pi = res.data.viewer?.organizations?.pageInfo
    orgMore = pi?.hasNextPage === true && typeof pi.endCursor === 'string'
    orgCursor = orgMore ? (pi?.endCursor ?? null) : null
  }

  if (viewerLogin) {
    rememberOwnerType(viewerLogin, 'user', host)
  }

  return {
    ok: true,
    projects: [...viewerProjects, ...orgProjects],
    ...(partialFailures.length > 0 ? { partialFailures } : {})
  }
}
