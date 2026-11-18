import { lstat, realpath, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AiVaultAgent } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { isPathInsideOrEqual } from '../../../../shared/file-access/cross-platform-path'
import { invalidateDeletedAiVaultSessionPaths } from '../../../ai-vault/deletion/host-session-delete'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { resolveOrcaManagedCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { codexDatedRolloutRelativePath } from '../resume/codex-session-resume-home'
import { holdCodexRolloutForDeletion } from '../rollouts/codex-rollout-deletion-guard'

type RolloutTarget = { agent: AiVaultAgent; filePath: string }
type DeleteResult = { deleted: number; failed: number; freedBytes: number }

type RolloutName = { path: string; root: string }

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** One name as found: what it reads (a link's target), and enough to tell if it changed. */
type NameState = {
  name: RolloutName
  path: string
  isHardLink: boolean
  /** dev:ino of the file it reads; null for a dangling link. */
  content: string | null
  version: string
  size: number
  nlink: bigint
}

/** The `YYYY/MM/DD/rollout-*.jsonl` stem in one of these homes; archived `.zst` maps to its `.jsonl`. */
function rolloutStem(homes: readonly string[], filePath: string): string | null {
  for (const home of homes) {
    const relativePath = codexDatedRolloutRelativePath(join(home, 'sessions'), filePath)
    if (relativePath) {
      return relativePath.replace(/\.zst$/, '')
    }
  }
  return null
}

/** Codex compresses idle rollouts and history passes link them across homes, so match by name. */
function rolloutNames(homes: readonly string[], stem: string): RolloutName[] {
  const parts = stem.split('/')
  const fileName = parts.at(-1) ?? stem
  return homes.flatMap((home) => {
    const sessions = join(home, 'sessions')
    const archived = join(home, 'archived_sessions')
    return [
      { path: join(sessions, ...parts), root: sessions },
      { path: `${join(sessions, ...parts)}.zst`, root: sessions },
      { path: join(archived, fileName), root: archived },
      { path: `${join(archived, fileName)}.zst`, root: archived }
    ]
  })
}

/** Null when absent; throws when it can't be proven absent, is no file, or leaves its home. */
async function readName(name: RolloutName): Promise<NameState | null> {
  let entry
  try {
    entry = await lstat(name.path, { bigint: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    throw new Error(`Not a rollout file: ${name.path}`)
  }
  // A dated folder linked elsewhere puts the name outside this home.
  const [realFolder, realRoot] = await Promise.all([
    realpath(dirname(name.path)),
    realpath(name.root)
  ])
  if (!isPathInsideOrEqual(realRoot, realFolder)) {
    throw new Error(`Rollout outside its Codex home: ${name.path}`)
  }
  const target = entry.isSymbolicLink()
    ? await stat(name.path, { bigint: true }).catch((error: unknown) => {
        if (isDefinitiveAbsence(error)) {
          return null
        }
        throw error
      })
    : entry
  return {
    name,
    path: name.path,
    isHardLink: entry.isFile(),
    // Some filesystems report inode 0 for every file: those names are checked one by one.
    content: target
      ? target.ino === 0n
        ? `path:${name.path}`
        : `${target.dev}:${target.ino}`
      : null,
    version: [
      entry.ino,
      entry.size,
      entry.mtimeNs,
      target?.ino,
      target?.size,
      target?.mtimeNs
    ].join(':'),
    size: Number(target?.size ?? 0n),
    nlink: entry.nlink
  }
}

async function readNames(names: readonly RolloutName[]): Promise<NameState[]> {
  const states: NameState[] = []
  for (const name of names) {
    const state = await readName(name)
    if (state) {
      states.push(state)
    }
  }
  return states
}

async function removeName(path: string): Promise<boolean> {
  try {
    // Unlink only ever removes the name: never a folder, never a link's target.
    await unlink(path)
    return true
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
}

/** Space returns only when a file's last link goes, so each file counts once and only then. */
function freedBytesOf(removed: readonly NameState[]): number {
  const linksByContent = new Map<string, { state: NameState; removed: number }>()
  for (const state of removed) {
    if (state.isHardLink && state.content) {
      const tally = linksByContent.get(state.content) ?? { state, removed: 0 }
      tally.removed += 1
      linksByContent.set(state.content, tally)
    }
  }
  let bytes = 0
  for (const { state, removed: count } of linksByContent.values()) {
    if (BigInt(count) >= state.nlink) {
      bytes += state.size
    }
  }
  return bytes
}

/**
 * Codex holds `thread-writer-locks/<thread id>.lock` while a process has the thread open, also
 * after a resume that hasn't written a turn yet; deleting then would cut off every later turn.
 * Codex versions that keep no locks give no such proof, so their rollouts are kept.
 */
async function isOpenInCodex(homes: readonly string[], stem: string): Promise<boolean> {
  // A reverted thread's name carries its thread id and its rollout id: either can be the lock's.
  const ids = basename(stem).toLowerCase().match(UUID_PATTERN) ?? []
  if (ids.length === 0) {
    return true
  }
  let keepsLocks = false
  for (const home of homes) {
    const locks = join(home, 'thread-writer-locks')
    for (const id of ids) {
      try {
        await lstat(join(locks, `${id}.lock`))
        return true
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          return true
        }
      }
    }
    keepsLocks ||= await lstat(locks).then(
      (entry) => entry.isDirectory(),
      () => false
    )
  }
  return !keepsLocks
}

async function deleteRollout(
  target: RolloutTarget,
  listHomes: () => Promise<readonly string[]>,
  shouldDelete: (target: RolloutTarget) => Promise<boolean>,
  result: DeleteResult,
  deletedPaths: string[]
): Promise<void> {
  const release = await holdCodexRolloutForDeletion(target.filePath)
  try {
    // Listed under the hold: an account added since the sweep began may already hold a link.
    const homes = await listHomes()
    const stem = rolloutStem(homes, target.filePath)
    if (!stem) {
      result.failed += 1
      return
    }
    const names = rolloutNames(homes, stem)
    if (await isOpenInCodex(homes, stem)) {
      return
    }
    const found = await readNames(names)
    // Every name, every extension: a chat resumed or still written anywhere keeps them all.
    const checked = new Set<string>()
    for (const state of found) {
      if (state.content === null || checked.has(state.content)) {
        continue
      }
      checked.add(state.content)
      if (!(await shouldDelete({ agent: 'codex', filePath: state.path }))) {
        return
      }
    }
    if (checked.size === 0) {
      return
    }
    // Reading takes a while: a name that appeared or changed meanwhile means the chat is in use.
    const current = await readNames(names)
    const versions = new Map(found.map((state) => [state.path, state.version]))
    if (
      current.length !== found.length ||
      current.some((state) => versions.get(state.path) !== state.version)
    ) {
      return
    }
    const removed: NameState[] = []
    // Links first: removing a link's target first would read as the link having changed.
    const order = [...found].sort((a, b) => Number(a.isHardLink) - Number(b.isHardLink))
    try {
      for (const { name } of order) {
        const state = await readName(name)
        if (!state) {
          continue
        }
        // Checked once more right before its own unlink: a resume opens or writes one name.
        if (state.version !== versions.get(name.path) || (await isOpenInCodex(homes, stem))) {
          return
        }
        if (await removeName(state.path)) {
          removed.push(state)
          deletedPaths.push(state.path)
        }
      }
    } finally {
      result.freedBytes += freedBytesOf(removed)
    }
    result.deleted += 1
    // A name another process links meanwhile is a fresh candidate for the next sweep's full checks.
    await rm(join(resolveOrcaManagedCodexHomePath(), '.orca-session-copies', `${stem}.json`), {
      force: true
    }).catch(() => undefined)
  } catch (error) {
    console.warn('[workspace-cleanup] Failed to delete Codex rollout:', target.filePath, error)
    result.failed += 1
  } finally {
    release()
  }
}

/**
 * Deletes each Codex rollout under every name it has in the listed homes, for good. `shouldDelete` is
 * asked once per distinct file right before removal; false keeps every name of that rollout.
 */
export async function deleteCodexRolloutsPermanently(
  targets: readonly RolloutTarget[],
  shouldDelete: (target: RolloutTarget) => Promise<boolean>,
  listHomes: () => Promise<readonly string[]>
): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: 0, failed: 0, freedBytes: 0 }
  const deletedPaths: string[] = []
  for (const target of targets) {
    await deleteRollout(target, listHomes, shouldDelete, result, deletedPaths)
  }
  await invalidateDeletedAiVaultSessionPaths(deletedPaths)
  return result
}
