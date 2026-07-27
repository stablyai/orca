import { getProjectIdentityKey } from '../shared/project-host-setup-projection'
import type { PersistedState } from '../shared/types'

const GITHUB_KEY_PREFIX = 'github:'

/** `github:<host>/<owner>/<repo>` → `github:<owner>/<repo>`. Only the host segment can be
 *  absent, and neither owner nor repo can contain a slash, so segment count is the test. */
function hostLessGitHubProjectId(projectId: string): string | null {
  if (!projectId.startsWith(GITHUB_KEY_PREFIX)) {
    return null
  }
  const parts = projectId.slice(GITHUB_KEY_PREFIX.length).split('/')
  if (parts.length !== 3) {
    return null
  }
  return `${GITHUB_KEY_PREFIX}${parts[1]}/${parts[2]}`
}

function isHostLessGitHubProjectId(projectId: string): boolean {
  return (
    projectId.startsWith(GITHUB_KEY_PREFIX) &&
    projectId.slice(GITHUB_KEY_PREFIX.length).split('/').length === 2
  )
}

/** Host-less id → the one host-qualified id it can only have meant. */
function buildHostQualifiedProjectIdMap(repos: PersistedState['repos']): Map<string, string> {
  const candidatesByHostLessId = new Map<string, Set<string>>()
  const genuineHostLessIds = new Set<string>()
  for (const repo of repos ?? []) {
    const projectId = getProjectIdentityKey(repo)
    if (isHostLessGitHubProjectId(projectId)) {
      // A live github.com repo owns this id for real; re-keying it would move that project.
      genuineHostLessIds.add(projectId)
      continue
    }
    const hostLessId = hostLessGitHubProjectId(projectId)
    if (!hostLessId) {
      continue
    }
    const candidates = candidatesByHostLessId.get(hostLessId) ?? new Set<string>()
    candidates.add(projectId)
    candidatesByHostLessId.set(hostLessId, candidates)
  }
  const remap = new Map<string, string>()
  for (const [hostLessId, candidates] of candidatesByHostLessId) {
    const [target] = [...candidates]
    // Two Enterprise hosts serving the same slug make the old id ambiguous; leave it alone
    // rather than guess which instance the stranded rows belonged to.
    if (!target || candidates.size !== 1 || genuineHostLessIds.has(hostLessId)) {
      continue
    }
    remap.set(hostLessId, target)
  }
  return remap
}

function remapSetupId(setupId: string, remap: Map<string, string>): string {
  // Projected setup ids are `<projectId>::<hostId>` (with a `::<n>` suffix on collision).
  for (const [from, to] of remap) {
    if (setupId.startsWith(`${from}::`)) {
      return `${to}${setupId.slice(from.length)}`
    }
  }
  return setupId
}

/**
 * Converges `projectId` references onto the host-qualified GitHub Enterprise ids the store
 * itself projects. Reads used to go through a sanitizer that dropped `upstream.host`, so the
 * renderer re-derived a host-less `github:<owner>/<repo>` and stamped it onto records —
 * worktree meta above all. Preserving the host (required for a GHES import to survive a
 * reload) makes those rows point at a project id nothing projects to anymore.
 *
 * Idempotent, so it can run on every load: once no host-less reference is left, or once a
 * genuine github.com repo claims the id, nothing matches. Out of scope: renderer-side caches
 * and anything else keyed by project id that this store does not persist.
 */
export function remapHostLessGitHubEnterpriseProjectIds(state: PersistedState): {
  state: PersistedState
  changed: boolean
} {
  const remap = buildHostQualifiedProjectIdMap(state.repos)
  if (remap.size === 0) {
    return { state, changed: false }
  }
  let changed = false
  const worktreeMeta: PersistedState['worktreeMeta'] = {}
  for (const [worktreeId, meta] of Object.entries(state.worktreeMeta ?? {})) {
    const target = meta.projectId ? remap.get(meta.projectId) : undefined
    const projectHostSetupId = meta.projectHostSetupId
      ? remapSetupId(meta.projectHostSetupId, remap)
      : undefined
    if (!target && projectHostSetupId === meta.projectHostSetupId) {
      worktreeMeta[worktreeId] = meta
      continue
    }
    changed = true
    worktreeMeta[worktreeId] = {
      ...meta,
      ...(target ? { projectId: target } : {}),
      ...(projectHostSetupId ? { projectHostSetupId } : {})
    }
  }
  const projects = (state.projects ?? []).map((project) => {
    const target = remap.get(project.id)
    if (!target) {
      return project
    }
    changed = true
    return { ...project, id: target }
  })
  const projectHostSetups = (state.projectHostSetups ?? []).map((setup) => {
    const target = remap.get(setup.projectId)
    const id = remapSetupId(setup.id, remap)
    if (!target && id === setup.id) {
      return setup
    }
    changed = true
    return { ...setup, id, ...(target ? { projectId: target } : {}) }
  })
  if (!changed) {
    return { state, changed: false }
  }
  return { state: { ...state, worktreeMeta, projects, projectHostSetups }, changed: true }
}
