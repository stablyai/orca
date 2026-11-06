import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { resolveGitMetadataPath } from '../../shared/git/metadata/git-metadata-path'
import { parseWslUncPath, toWindowsWslDrivePath } from '../../shared/wsl-paths'
import {
  readGitAdminFile,
  resolveGitCommonDirectory
} from '../../shared/git/metadata/git-common-directory'
import { canonicalWorktreePath } from './worktrees/catalog/worktree-path-comparison'
import { runWithGitOperationLock } from '../../shared/git/commands/git-operation-lock'
import { resolveGitFetchHeadCommand } from '../../shared/git/fetch/git-fetch-head-lock'
import {
  findGitSubcommandIndex,
  isWslDirectGitReadCommand
} from '../../shared/git/commands/git-command-classification'

const heldLanes = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>()
const attachmentCommands = new Set([
  'checkout',
  'switch',
  'worktree',
  'branch',
  'symbolic-ref',
  'update-ref',
  'rebase',
  'bisect',
  'reset',
  'merge',
  'cherry-pick',
  'revert',
  'am',
  'pull'
])

type AttachmentOptions = { signal?: AbortSignal; wslDistro?: string }

async function repoAttachmentKey(
  repoPath: string,
  options: AttachmentOptions,
  explicitGitDir?: string
): Promise<string> {
  let current = explicitGitDir ?? repoPath
  let commonDir: string | null = null
  while (!commonDir) {
    commonDir = await resolveGitCommonDirectory(current, options)
    const parent = dirname(current)
    if (commonDir || explicitGitDir || parent === current) {
      break
    }
    current = parent
  }
  let canonical: string
  if (commonDir) {
    try {
      canonical = await realpath(commonDir)
    } catch (error) {
      // Git gitfiles can contain embedded newlines in their filesystem pointer.
      const marker = await readGitAdminFile(join(current, '.git'), options.signal)
      if (!marker?.startsWith('gitdir:') || !marker.trimEnd().includes('\n')) {
        throw error
      }
      const gitDir = resolveGitMetadataPath(current, marker.slice(7), options)
      const fullCommon = gitDir && (await resolveGitCommonDirectory(gitDir, options))
      if (!fullCommon) {
        throw error
      }
      canonical = await realpath(fullCommon)
    }
  } else {
    canonical = await realpath(repoPath).catch(() => resolve(repoPath))
  }
  const wsl = parseWslUncPath(canonical)
  const drivePath = wsl && toWindowsWslDrivePath(wsl.linuxPath)
  return `repo-attachments:${canonicalWorktreePath(drivePath || canonical)}`
}

export async function runWithRepoAttachmentLock<T>(
  repoPath: string,
  options: AttachmentOptions,
  run: () => Promise<T>,
  explicitGitDir?: string
): Promise<T> {
  const key = await repoAttachmentKey(repoPath, options, explicitGitDir)
  const parent = heldLanes.getStore()
  if (parent?.get(key)?.active) {
    return run()
  }
  return runWithGitOperationLock(key, options.signal, async () => {
    const ownership = { active: true }
    const lanes = new Map(parent)
    lanes.set(key, ownership)
    try {
      return await heldLanes.run(lanes, run)
    } finally {
      ownership.active = false
    }
  })
}

export function runWithGitAttachmentMutation<T>(
  args: string[],
  options: AttachmentOptions & { cwd: string; admissionSignal?: AbortSignal },
  run: () => Promise<T>,
  terminated: () => Promise<void> | null
): Promise<T> {
  if (
    !attachmentCommands.has(args[findGitSubcommandIndex(args)]) ||
    isWslDirectGitReadCommand(args)
  ) {
    return run()
  }
  const target = resolveGitFetchHeadCommand(args, options.cwd)
  // Preserve caller timeout settlement while the fence still owns the live child.
  const response = Promise.withResolvers<T>()
  const invoke = async (nested: boolean) => {
    try {
      const value = await run()
      if (nested) {
        await terminated()
      }
      response.resolve(value)
    } catch (error) {
      if (nested) {
        await terminated()
      }
      response.reject(error)
    } finally {
      await terminated()
    }
  }
  const waiting = { ...options, signal: options.admissionSignal ?? options.signal }
  void repoAttachmentKey(target.cwd, waiting, target.gitDir)
    .then((key) =>
      heldLanes.getStore()?.get(key)?.active
        ? invoke(true)
        : runWithGitOperationLock(key, waiting.signal, () => invoke(false))
    )
    .catch(response.reject)
  return response.promise
}
