import { open, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { getErrorCode } from './worktree-operation-options'
import { parseWorktreePreparationOwnerPid } from '../../shared/worktree/create-preparation'

/** Existence only: the hook's content is never read. */
export type PostCheckoutHookPresence = 'present' | 'absent' | 'custom_hooks_path' | 'unknown'

export type CreateEventRepoFacts = {
  postCheckoutHook: PostCheckoutHookPresence
  /** Entries in the index header, i.e. tracked files; absent when the count is missing or unreliable. */
  indexEntryCount?: number
  /** The main checkout plus registered linked worktrees, Orca's prepared checkouts excluded. */
  worktreeCount?: number
}

const PROBE_TIMEOUT_MS = 2_000
// Shorter than the whole probe, so a slow per-worktree read cannot cost the other facts.
const WORKTREE_COUNT_TIMEOUT_MS = 1_500

/** Mount reads are best-effort and must not hold the caller indefinitely. */
async function withTimeout<T>(operation: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read repo-local facts without spawning Git; linked-worktree/submodule .git files yield none.
 * Report local core.hooksPath without following it; global/included configuration is not read.
 */
export function probeCreateEventRepoFacts(
  repoPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<CreateEventRepoFacts> {
  return withTimeout(readFacts(repoPath, platform), PROBE_TIMEOUT_MS, {
    postCheckoutHook: 'unknown'
  })
}

async function readFacts(
  repoPath: string,
  platform: NodeJS.Platform
): Promise<CreateEventRepoFacts> {
  const gitDir = path.join(repoPath, '.git')
  const isGitDirectory = await stat(gitDir).then(
    (entry) => entry.isDirectory(),
    () => false
  )
  if (!isGitDirectory) {
    return { postCheckoutHook: 'unknown' }
  }
  // `git sparse-checkout --sparse-index` and per-worktree settings write to config.worktree.
  const [mainConfig, worktreeConfig] = await Promise.all([
    readFile(path.join(gitDir, 'config'), 'utf8').catch(() => null),
    readFile(path.join(gitDir, 'config.worktree'), 'utf8').catch(() => '')
  ])
  const config = mainConfig === null ? null : `${mainConfig}\n${worktreeConfig}`
  const [postCheckoutHook, indexEntryCount, worktreeCount] = await Promise.all([
    readPostCheckoutHook(gitDir, config, platform),
    readIndexEntryCount(gitDir, config),
    withTimeout(readWorktreeCount(gitDir), WORKTREE_COUNT_TIMEOUT_MS, undefined)
  ])
  return {
    postCheckoutHook,
    ...(indexEntryCount !== undefined ? { indexEntryCount } : {}),
    ...(worktreeCount !== undefined ? { worktreeCount } : {})
  }
}

/** Exclude prepared checkouts from every process, including crash leftovers. */
async function readWorktreeCount(gitDir: string): Promise<number | undefined> {
  const registry = path.join(gitDir, 'worktrees')
  try {
    const entries = await readdir(registry, { withFileTypes: true })
    const preparations = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          readFile(path.join(registry, entry.name, 'locked'), 'utf8').then(
            (reason) => parseWorktreePreparationOwnerPid(reason.trim()) !== null,
            () => false
          )
        )
    )
    return preparations.filter((isPreparation) => !isPreparation).length + 1
  } catch (error) {
    return getErrorCode(error) === 'ENOENT' ? 1 : undefined
  }
}

/** `core.sparseCheckout` or `index.sparse` set to anything Git reads as true, bare key included. */
const SPARSE_CHECKOUT_ON = /^\s*sparse(checkout)?\s*(=(?!\s*(false|no|off|0)\s*$).*)?$/im

/** Read DIRC entry count; omit split/sparse indexes because their header count is not the tracked-file total. */
async function readIndexEntryCount(
  gitDir: string,
  config: string | null
): Promise<number | undefined> {
  if (config === null || SPARSE_CHECKOUT_ON.test(config)) {
    return undefined
  }
  try {
    const entries = await readdir(gitDir)
    if (entries.some((name) => name.startsWith('sharedindex.'))) {
      return undefined
    }
    const index = await open(path.join(gitDir, 'index'), 'r')
    try {
      const header = Buffer.alloc(12)
      const { bytesRead } = await index.read(header, 0, 12, 0)
      if (bytesRead < 12 || header.toString('latin1', 0, 4) !== 'DIRC') {
        return undefined
      }
      return header.readUInt32BE(8)
    } finally {
      await index.close()
    }
  } catch {
    return undefined
  }
}

async function readPostCheckoutHook(
  gitDir: string,
  config: string | null,
  platform: NodeJS.Platform
): Promise<PostCheckoutHookPresence> {
  if (config === null) {
    return 'unknown'
  }
  try {
    if (/^\s*hookspath\s*=/im.test(config)) {
      return 'custom_hooks_path'
    }
    const hook = await stat(path.join(gitDir, 'hooks', 'post-checkout')).catch((error) => {
      if (getErrorCode(error) === 'ENOENT') {
        return null
      }
      throw error
    })
    if (!hook || !hook.isFile()) {
      return 'absent'
    }
    // Git skips a hook without an execute bit, except on Windows where it has none to check.
    return platform === 'win32' || (hook.mode & 0o111) !== 0 ? 'present' : 'absent'
  } catch {
    return 'unknown'
  }
}
