import { lstat, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type {
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanResult
} from '../../shared/workspace-cleanup'
import {
  WORKSPACE_CLEANUP_STRAY_DIRECTORY_LIMIT,
  type WorkspaceCleanupStrayDirectory,
  type WorkspaceCleanupStrayDirectoryScan
} from '../../shared/workspace-cleanup-stray-directories'
import { failedWorktreeRemovals, pendingWorktreeRemovals } from '../worktree-removal-table'
import {
  classifyWorkspaceCleanupStrayDirectory,
  toWorkspaceCleanupStrayPathKey,
  type WorkspaceCleanupStrayGuard
} from './workspace-cleanup-stray-directory-classifier'
import {
  planWorkspaceCleanupStrayRoots,
  type WorkspaceCleanupStrayRoot,
  type WorkspaceCleanupStrayStore
} from './workspace-cleanup-stray-directory-roots'
import { hasTargetedWorkspaceCleanupScan } from './workspace-cleanup-scan-targets'
import {
  WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
  WorkspaceCleanupScanCancelledError,
  appendWorkspaceCleanupItems,
  mapWorkspaceCleanupWithConcurrency,
  throwIfWorkspaceCleanupScanAborted,
  withWorkspaceCleanupTimeout
} from './workspace-cleanup-scan-primitives'

// Why: bounds one root's cost the same way the trash sweep bounds its containers.
const MAX_ENTRIES_PER_DIRECTORY = 500
const STRAY_DIRECTORY_CONCURRENCY = 3

type StrayRootContext = {
  guard: WorkspaceCleanupStrayGuard
  projectPaths: readonly string[]
  scannedAt: number
  signal?: AbortSignal
}

/** Full-list broad scans only: an older client's suggestion view has no place for these rows. */
export function scanWorkspaceCleanupStrayDirectoriesForScan(
  store: WorkspaceCleanupStrayStore,
  args: WorkspaceCleanupScanArgs,
  result: Pick<WorkspaceCleanupScanResult, 'scannedAt' | 'candidates'>,
  signal?: AbortSignal
): Promise<WorkspaceCleanupStrayDirectoryScan | undefined> {
  if (args.includeAllWorkspaces !== true || hasTargetedWorkspaceCleanupScan(args)) {
    return Promise.resolve(undefined)
  }
  return scanWorkspaceCleanupStrayDirectories({
    store,
    registeredWorktreePaths: result.candidates.map((candidate) => candidate.path),
    scannedAt: result.scannedAt,
    signal
  })
}

/**
 * Finds unregistered folders in Orca's local worktree roots. Returns undefined when the roots
 * cannot be planned, so a caller never shows "nothing found" for a root it did not read.
 */
export async function scanWorkspaceCleanupStrayDirectories(args: {
  store: WorkspaceCleanupStrayStore
  /** Every worktree path the scan's listings registered. */
  registeredWorktreePaths: readonly string[]
  scannedAt: number
  signal?: AbortSignal
}): Promise<WorkspaceCleanupStrayDirectoryScan | undefined> {
  let plan: ReturnType<typeof planWorkspaceCleanupStrayRoots>
  try {
    plan = planWorkspaceCleanupStrayRoots(args.store)
  } catch (error) {
    console.warn('Workspace cleanup could not resolve worktree roots', error)
    return undefined
  }
  const projectPaths = await withCanonicalPaths(plan.projectPaths, args.signal)
  const context: StrayRootContext = {
    guard: buildWorkspaceCleanupStrayGuard([...args.registeredWorktreePaths, ...projectPaths]),
    projectPaths,
    scannedAt: args.scannedAt,
    signal: args.signal
  }
  const skipped = new Map(plan.skipped)
  const directories: WorkspaceCleanupStrayDirectory[] = []
  for (const root of plan.roots) {
    throwIfWorkspaceCleanupScanAborted(args.signal)
    const outcome = await scanStrayRoot(root, context)
    if (outcome.skip) {
      skipped.set(outcome.skip, (skipped.get(outcome.skip) ?? 0) + 1)
    }
    appendWorkspaceCleanupItems(directories, outcome.directories)
  }
  directories.sort((a, b) => a.lastModifiedAt - b.lastModifiedAt)
  return {
    directories: directories.slice(0, WORKSPACE_CLEANUP_STRAY_DIRECTORY_LIMIT),
    skippedRoots: [...skipped].map(([reason, count]) => ({ reason, count })),
    truncated: directories.length > WORKSPACE_CLEANUP_STRAY_DIRECTORY_LIMIT
  }
}

export function buildWorkspaceCleanupStrayGuard(
  ownedPaths: readonly string[]
): WorkspaceCleanupStrayGuard {
  const removals = [...pendingWorktreeRemovals.values(), ...failedWorktreeRemovals.values()]
  return {
    ownedPathKeys: new Set(ownedPaths.map(toWorkspaceCleanupStrayPathKey)),
    removalPathKeys: new Set(
      removals.map((record) => toWorkspaceCleanupStrayPathKey(record.worktreePath))
    )
  }
}

/** The folders a root's layout puts checkouts in: the root itself, or each project folder. */
export async function listWorkspaceCleanupStrayParents(
  root: WorkspaceCleanupStrayRoot,
  canonicalRoot: string
): Promise<{ parentPath: string; containerName?: string; repoIds: string[] }[]> {
  if (root.layout === 'flat') {
    return [{ parentPath: canonicalRoot, repoIds: root.repoIds }]
  }
  const parents: { parentPath: string; containerName: string; repoIds: string[] }[] = []
  for (const [containerName, repoIds] of root.containers) {
    const parentPath = path.join(canonicalRoot, containerName)
    const entry = await lstat(parentPath).catch(() => null)
    // Why: a project folder that is itself a checkout is never descended into.
    const hasGitEntry = await lstat(path.join(parentPath, '.git')).then(
      () => true,
      () => false
    )
    if (entry?.isDirectory() && !entry.isSymbolicLink() && !hasGitEntry) {
      parents.push({ parentPath, containerName, repoIds })
    }
  }
  return parents
}

async function scanStrayRoot(
  root: WorkspaceCleanupStrayRoot,
  context: StrayRootContext
): Promise<{
  directories: WorkspaceCleanupStrayDirectory[]
  skip?: 'holds-projects' | 'unreadable'
}> {
  try {
    return await withWorkspaceCleanupTimeout(
      async () => {
        const canonicalRoot = await realpath(root.path).catch(() => null)
        if (!canonicalRoot) {
          return { directories: [] }
        }
        if (context.projectPaths.some((project) => isPathInsideOrEqual(canonicalRoot, project))) {
          return { directories: [], skip: 'holds-projects' as const }
        }
        const directories: WorkspaceCleanupStrayDirectory[] = []
        for (const parent of await listWorkspaceCleanupStrayParents(root, canonicalRoot)) {
          const names = await listChildDirectoryNames(parent.parentPath)
          const verdicts = await mapWorkspaceCleanupWithConcurrency(
            names,
            STRAY_DIRECTORY_CONCURRENCY,
            async (name) => {
              throwIfWorkspaceCleanupScanAborted(context.signal)
              const directoryPath = path.join(parent.parentPath, name)
              const verdict = await classifyWorkspaceCleanupStrayDirectory(
                directoryPath,
                context.guard,
                context.scannedAt
              )
              return verdict.stray ? { directoryPath, verdict } : null
            }
          )
          for (const match of verdicts) {
            if (match) {
              directories.push({
                path: match.directoryPath,
                rootPath: canonicalRoot,
                ...(parent.containerName ? { containerName: parent.containerName } : {}),
                repoIds: parent.repoIds,
                lastModifiedAt: match.verdict.lastModifiedAt,
                gitLink: match.verdict.gitLink,
                reasons: ['unregistered'],
                tier: 'review',
                selectedByDefault: false
              })
            }
          }
        }
        return { directories }
      },
      // Why one deadline per root: fs reads cannot be cancelled, so a hung mount costs one budget.
      WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
      'Timed out reading a worktree root.',
      context.signal
    )
  } catch (error) {
    if (error instanceof WorkspaceCleanupScanCancelledError) {
      throw error
    }
    console.warn('Workspace cleanup skipped an unreadable worktree root', error)
    return { directories: [], skip: 'unreadable' }
  }
}

async function listChildDirectoryNames(directoryPath: string): Promise<string[]> {
  const directory = await opendir(directoryPath)
  const names: string[] = []
  try {
    for (let seen = 0; seen < MAX_ENTRIES_PER_DIRECTORY; seen += 1) {
      const entry = await directory.read()
      if (!entry) {
        break
      }
      // Hidden entries include Orca's own `.orca-preparing` and `.orca-worktree-trash`.
      if (!entry.name.startsWith('.') && entry.isDirectory()) {
        names.push(entry.name)
      }
    }
  } finally {
    await directory.close().catch(() => {})
  }
  return names
}

/** Raw and resolved spellings, since Git records realpaths and repos keep what the user added. */
export async function withCanonicalPaths(
  paths: readonly string[],
  signal?: AbortSignal
): Promise<string[]> {
  const canonical = await withWorkspaceCleanupTimeout(
    () =>
      mapWorkspaceCleanupWithConcurrency(paths, STRAY_DIRECTORY_CONCURRENCY, (value) =>
        realpath(value).catch(() => value)
      ),
    WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
    'Timed out resolving project paths.',
    signal
  ).catch((error: unknown) => {
    if (error instanceof WorkspaceCleanupScanCancelledError) {
      throw error
    }
    return []
  })
  return [...new Set([...paths, ...canonical])]
}
