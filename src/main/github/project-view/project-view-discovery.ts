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

// Bound organization discovery to avoid 504s/quota drain; overflow projects remain accessible by URL.
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

export async function listAccessibleProjects(
  args?: ListAccessibleProjectsArgs
): Promise<ListAccessibleProjectsResult> {
  const host = githubProjectHost(args?.host)
  const viewerProjects: GitHubProjectSummary[] = []
  const orgProjects: GitHubProjectSummary[] = []
  const partialFailures: { owner: string; message: string }[] = []
  let viewerLogin: string | null = null

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
      // Viewer discovery failure is fatal; organization failures can preserve partial results.
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

  // Skip per-org continuation, the dominant 504 cost; overflow projects can be pasted by URL.
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
      // Preserve viewer projects and mark the organization-list failure for the partial-results banner.
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
