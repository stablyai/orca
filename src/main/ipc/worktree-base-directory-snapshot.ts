import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { WorktreeBaseRepoWatchConfig } from './worktree-base-directory-event-filter'
import {
  WorktreePollingScanBudget,
  type WorktreePollingScanLimits
} from './worktree-polling-scan-budget'

export type WorktreeBaseDirectorySnapshot = {
  markers: Map<string, boolean>
  gateDirs: string[]
}

function statSignature(value: { mtimeMs: number; ctimeMs: number; ino: number }): string {
  return `${value.mtimeMs}:${value.ctimeMs}:${value.ino}`
}

async function directorySignature(path: string): Promise<string> {
  try {
    return statSignature(await stat(path))
  } catch {
    return 'missing'
  }
}

export async function hasWorktreeGitMarker(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

export async function takeWorktreeBaseDirectorySnapshot(
  rootPath: string,
  repos: ReadonlyMap<string, WorktreeBaseRepoWatchConfig>,
  scanLimits: Partial<WorktreePollingScanLimits>
): Promise<WorktreeBaseDirectorySnapshot> {
  const markers = new Map<string, boolean>()
  const gateDirs = [rootPath]
  const budget = new WorktreePollingScanBudget(scanLimits)
  budget.claimRetainedPath(rootPath)
  let includeFlat = false
  const nestedRepoNames = new Set<string>()
  for (const config of repos.values()) {
    budget.claimRepoConfig(config.repoId, config.repoName)
    if (config.nestWorkspaces) {
      nestedRepoNames.add(normalizeRuntimePathForComparison(config.repoName))
    } else {
      includeFlat = true
    }
  }

  let rootDirectory
  try {
    rootDirectory = await opendir(rootPath, { bufferSize: 32 })
  } catch {
    return { markers, gateDirs }
  }

  const candidates: string[] = []
  for await (const entry of rootDirectory) {
    budget.claimEntry()
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue
    }
    const entryPath = join(rootPath, entry.name)
    if (includeFlat) {
      budget.claimRetainedPath(entryPath)
      candidates.push(entryPath)
    }
    if (!nestedRepoNames.has(normalizeRuntimePathForComparison(entry.name))) {
      continue
    }
    budget.claimRetainedPath(entryPath)
    gateDirs.push(entryPath)
    let subDirectory
    try {
      subDirectory = await opendir(entryPath, { bufferSize: 32 })
    } catch {
      continue
    }
    for await (const sub of subDirectory) {
      budget.claimEntry()
      if (sub.isDirectory() || sub.isSymbolicLink()) {
        const candidatePath = join(entryPath, sub.name)
        budget.claimRetainedPath(candidatePath)
        candidates.push(candidatePath)
      }
    }
  }

  for (const dir of candidates) {
    markers.set(dir, await hasWorktreeGitMarker(dir))
  }
  return { markers, gateDirs }
}

export async function collectWorktreeBaseDirectorySignatures(
  paths: readonly string[]
): Promise<string[]> {
  const signatures: string[] = []
  for (const path of paths) {
    signatures.push(await directorySignature(path))
  }
  return signatures
}
