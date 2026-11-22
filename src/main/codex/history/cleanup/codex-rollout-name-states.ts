import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isPathInsideOrEqual } from '../../../../shared/file-access/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import type { RolloutName } from './codex-rollout-names'

/** One name as found: what it reads (a link's target), and enough to tell if it changed. */
export type NameState = {
  name: RolloutName
  path: string
  isHardLink: boolean
  /** dev:ino of the file it reads; null for a dangling link. */
  content: string | null
  version: string
  size: number
  nlink: bigint
}

/** Null when absent; throws when it can't be proven absent, is no file, or leaves its home. */
export async function readName(name: RolloutName): Promise<NameState | null> {
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

export async function readNames(names: readonly RolloutName[]): Promise<NameState[]> {
  const states: NameState[] = []
  for (const name of names) {
    const state = await readName(name)
    if (state) {
      states.push(state)
    }
  }
  return states
}

/** Space returns only when a file's last link goes, so each file counts once and only then. */
export function freedBytesOf(removed: readonly NameState[]): number {
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
