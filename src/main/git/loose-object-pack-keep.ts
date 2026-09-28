import { readdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LOOSE_OBJECT_PACK_BASE_NAME,
  LOOSE_OBJECT_PACK_KEEP_CONTENT
} from '../../shared/repo-maintenance-policy'
import { readPackIndexObjectCount } from './pack-index-object-ids'

/**
 * The `.keep` files Orca puts beside its own loose-object packs, and the packs
 * they hold. Every path here is in the main process's spelling of the pack
 * directory; Git is never asked, because a directory listing answers it.
 *
 * Ownership is decided by content, never by name alone: Git's own
 * `maintenance --task=loose-objects` writes `loose-*.pack` too, and a user can
 * keep any pack by hand. Only a keep that says Orca wrote it is Orca's to drop.
 */

const KEPT_PACK_NAME = new RegExp(
  `^(${LOOSE_OBJECT_PACK_BASE_NAME}-([0-9a-f]{40}|[0-9a-f]{64}))\\.keep$`
)
/** The hex id Git prints for the pack it just wrote. */
const PACK_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/**
 * Git's own order when it drops a pack: everything but the index first, so a
 * reader never finds an index whose pack is gone, then the index. The keep goes
 * last, so the pack is never unkept while any of it is still on disk.
 */
const PACK_FILE_EXTENSIONS = ['.pack', '.rev', '.mtimes', '.bitmap', '.promisor', '.idx'] as const

export type KeptLooseObjectPack = {
  /** `loose-<hash>`, the name every file of the pack shares. */
  name: string
  hashHexLength: 40 | 64
  /** The `.pack` mtime: what Git itself ages the pack's objects by. */
  mtimeMs: number
  /** `undefined` when the index cannot be read as version 2. */
  objectCount: number | undefined
  /** The keep outlived its pack, as after a merge interrupted mid-cleanup. */
  orphaned: boolean
}

export function packHashFromPackObjectsOutput(stdout: string): string | undefined {
  const hash = stdout.trim()
  return PACK_HASH.test(hash) ? hash : undefined
}

/** Keep the pack `pack-objects` just wrote, so a pre-cruft `gc` cannot explode it. */
export async function keepLooseObjectPack(packDirectory: string, hash: string): Promise<void> {
  await writeFile(
    join(packDirectory, `${LOOSE_OBJECT_PACK_BASE_NAME}-${hash}.keep`),
    LOOSE_OBJECT_PACK_KEEP_CONTENT
  )
}

/** Every pack Orca keeps in `packDirectory`, oldest first. */
export async function listKeptLooseObjectPacks(
  packDirectory: string,
  signal?: AbortSignal
): Promise<KeptLooseObjectPack[]> {
  let names: string[]
  try {
    names = await readdir(packDirectory)
  } catch {
    return []
  }
  const packs: KeptLooseObjectPack[] = []
  for (const fileName of names) {
    signal?.throwIfAborted()
    const match = KEPT_PACK_NAME.exec(fileName)
    if (!match) {
      continue
    }
    const content = await readFile(join(packDirectory, fileName), 'utf8').catch(() => '')
    if (content !== LOOSE_OBJECT_PACK_KEEP_CONTENT) {
      continue
    }
    const name = match[1]
    const hashHexLength = match[2].length === 64 ? 64 : 40
    const packStat = await stat(join(packDirectory, `${name}.pack`)).catch(() => undefined)
    packs.push({
      name,
      hashHexLength,
      mtimeMs: packStat?.mtimeMs ?? 0,
      objectCount: packStat
        ? await readPackIndexObjectCount(join(packDirectory, `${name}.idx`))
        : undefined,
      orphaned: packStat === undefined
    })
  }
  return packs.sort((a, b) => a.mtimeMs - b.mtimeMs)
}

/** Hand the pack back to Git's own `gc`, which from here on owns it outright. */
export async function releaseLooseObjectPack(packDirectory: string, name: string): Promise<void> {
  await unlinkIfPresent(join(packDirectory, `${name}.keep`))
}

/** Delete a pack whose every object another pack now carries. */
export async function removeLooseObjectPack(packDirectory: string, name: string): Promise<void> {
  for (const extension of PACK_FILE_EXTENSIONS) {
    await unlinkIfPresent(join(packDirectory, `${name}${extension}`))
  }
  await releaseLooseObjectPack(packDirectory, name)
}

/** Age a pack's objects as of `mtimeMs`, the way Git's own freshening does. */
export async function setLooseObjectPackMtime(
  packDirectory: string,
  name: string,
  mtimeMs: number
): Promise<void> {
  const seconds = mtimeMs / 1000
  await utimes(join(packDirectory, `${name}.pack`), seconds, seconds)
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
}
