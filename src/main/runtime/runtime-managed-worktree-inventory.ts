import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import {
  toDetectedWorktree,
  buildKnownOrcaWorkspaceLayouts,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../shared/worktree/ownership'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'
import type { Repo } from '../../shared/repo-types'
import type {
  WorktreeInventoryRequest,
  WorktreeInventoryResult,
  WorktreeInventoryFailureReason
} from '../../shared/worktree/inventory'
import type { DetectedWorktree, GitWorktreeInfo } from '../../shared/worktree/types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { parseWslPath } from '../wsl'
import type { Store } from '../persistence'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'

export async function listWorktreeInventory(
  store: RuntimeStore | null,
  request: WorktreeInventoryRequest,
  scanRepo: (repo: Repo) => Promise<RuntimeWorktreeScanResult>
): Promise<WorktreeInventoryResult> {
  const result: WorktreeInventoryResult = {
    scope: { ...request, repoId: null, projectHostSetupId: null },
    source: 'git-and-orca-records',
    authoritative: false,
    truncated: false,
    totalCount: 0,
    failureReasons: [],
    worktrees: [],
    records: []
  }
  const fail = (reason: WorktreeInventoryFailureReason) => {
    result.failureReasons.push(reason)
    return result
  }
  if (request.hostId !== 'local') {
    return fail('unsupported_host')
  }
  if (!store?.getWorktreeInventoryRecords || !store.getProjects || !store.getProjectHostSetups) {
    return fail('records_unavailable')
  }
  const resolveScope = () => {
    const repos = store
      .getRepos()
      .filter(
        (repo) =>
          request.repo === `id:${repo.id}` && getRepoExecutionHostId(repo) === request.hostId
      )
    if (repos.length !== 1 || repos[0].path !== request.repoPath || repos[0].connectionId) {
      return null
    }
    const repo = repos[0]
    const projects = store.getProjects!().filter((project) =>
      project.sourceRepoIds.includes(repo.id)
    )
    const setups = store.getProjectHostSetups!().filter(
      (setup) =>
        (setup.repoId === repo.id || setup.projectId === request.projectId) &&
        setup.hostId === request.hostId
    )
    if (
      projects.length !== 1 ||
      projects[0].id !== request.projectId ||
      setups.length !== 1 ||
      setups[0].repoId !== repo.id ||
      setups[0].projectId !== request.projectId ||
      setups[0].path !== request.repoPath
    ) {
      return null
    }
    return { repo, project: projects[0], setup: setups[0] }
  }
  const resolved = resolveScope()
  if (!resolved) {
    return fail('scope_mismatch')
  }
  const { repo, setup } = resolved
  result.scope.repoId = repo.id
  result.scope.projectHostSetupId = setup.id
  if (isFolderRepo(repo)) {
    return fail('unsupported_workspace')
  }
  const isNativeRuntime = () => {
    try {
      return (
        !parseWslPath(repo.path) &&
        !getLocalProjectWorktreeGitOptions(store as Store, repo).wslDistro
      )
    } catch {
      return false
    }
  }
  if (!isNativeRuntime()) {
    return fail('unsupported_runtime')
  }
  const scopeBefore = JSON.stringify(resolved)
  const recordsBefore = store.getWorktreeInventoryRecords(repo.id, request.hostId)
  let scan: RuntimeWorktreeScanResult
  try {
    scan = await scanRepo(repo)
  } catch {
    scan = { ok: false, worktrees: [] }
  }
  const recordsAfter = store.getWorktreeInventoryRecords(repo.id, request.hostId)
  result.records = recordsAfter.records
  // Failed scans may contain fallback rows, which must never look like fresh Git evidence.
  result.worktrees = scan.ok ? detectInventoryWorktrees(store, repo, scan.worktrees) : []
  result.totalCount = result.worktrees.length + result.records.length
  if (JSON.stringify(resolveScope()) !== scopeBefore || !isNativeRuntime()) {
    fail('scope_changed')
  }
  if (JSON.stringify(recordsBefore) !== JSON.stringify(recordsAfter)) {
    fail('records_changed')
  }
  if (!scan.ok) {
    fail('scan_failed')
  }
  if (
    recordsAfter.ambiguous ||
    result.records.some(
      (row) =>
        (row.projectId && row.projectId !== request.projectId) ||
        (row.projectHostSetupId && row.projectHostSetupId !== setup.id)
    )
  ) {
    fail('records_ambiguous')
  }
  result.authoritative = result.failureReasons.length === 0
  return result
}

function detectInventoryWorktrees(
  store: RuntimeStore,
  repo: Repo,
  rows: GitWorktreeInfo[]
): DetectedWorktree[] {
  const settings = store.getSettings()
  const hostId = getRepoExecutionHostId(repo)
  const metadata = readAllWorktreeMetaForHost(store, hostId)
  const worktreeVisibilitySourceMatcher = createWorktreeVisibilitySourceMatcher(
    [repo.path, ...rows.map((row) => row.path)],
    resolveCustomWorktreeVisibilitySources(repo, settings.worktreeVisibilityDefaults),
    resolveConfiguredWorktreeBasePaths(repo)
  )
  const knownOrcaLayouts = buildKnownOrcaWorkspaceLayouts(settings, repo)
  return rows.map((row) => {
    const meta = metadata[`${repo.id}::${row.path}`]
    return toDetectedWorktree({
      repo,
      settings,
      meta,
      knownOrcaLayouts,
      worktree: { ...mergeWorktree(repo.id, row, meta, repo.displayName), ...row, hostId },
      isLegacyRepoForVisibility: isLegacyRepoForExternalWorktreeVisibility(repo),
      worktreeVisibilitySourceMatcher
    })
  })
}
