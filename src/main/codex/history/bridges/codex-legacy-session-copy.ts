import type { Stats } from 'node:fs'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { linkCodexSessionFileAsync } from '../rollouts/codex-session-link'
import { isCodexThreadOpen } from '../rollouts/codex-thread-open-check'

/**
 * Replaces a copy Orca made earlier with a link to its source, only when the source still holds
 * every byte of the copy and no Codex has the thread open. The copy moves aside rather than being
 * deleted until the swap is rechecked, so a write that lands meanwhile puts it back.
 */
export async function replaceCopyWithSourceLink(args: {
  sourcePath: string
  copyPath: string
  threadHomes: readonly string[]
}): Promise<boolean> {
  const { sourcePath, copyPath } = args
  let replacementPath: string | null = null
  let heldPath: string | null = null
  try {
    const checked = await lstat(copyPath)
    const safeToReplace = async (path: string): Promise<boolean> =>
      sameFile(await lstat(path), checked) &&
      (await sourceStartsWithCopy(sourcePath, path)) &&
      !(await isCodexThreadOpen(args.threadHomes, copyPath))
    if (!(await safeToReplace(copyPath))) {
      return false
    }
    const suffix = `${process.pid}-${Date.now()}`
    replacementPath = `${copyPath}.orca-link-${suffix}`
    if (
      (await linkCodexSessionFileAsync(sourcePath, replacementPath, { hardlinkOnly: false })) !==
      'linked'
    ) {
      replacementPath = null
      return false
    }
    heldPath = `${copyPath}.orca-held-${suffix}`
    await rename(copyPath, heldPath)
    await rename(replacementPath, copyPath)
    replacementPath = null
    // Rechecked after the swap: anything written to the copy since the check survives.
    if (!(await safeToReplace(heldPath))) {
      await rename(heldPath, copyPath)
      heldPath = null
      return false
    }
    await rm(heldPath, { force: true })
    heldPath = null
    return true
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Failed to replace copied Codex session:',
      sourcePath,
      error
    )
    if (heldPath) {
      await rename(heldPath, copyPath).catch((restoreError: unknown) => {
        console.warn('[codex-session-bridge] Copy kept at', heldPath, restoreError)
      })
    }
    if (replacementPath) {
      await rm(replacementPath, { force: true }).catch(() => {})
    }
    return false
  }
}

function sameFile(current: Stats, checked: Stats): boolean {
  return (
    current.isFile() &&
    current.ino === checked.ino &&
    current.size === checked.size &&
    current.mtimeMs === checked.mtimeMs
  )
}

/** Whether `sourcePath` begins with every byte of the copy, so linking to it loses nothing. */
async function sourceStartsWithCopy(sourcePath: string, copyPath: string): Promise<boolean> {
  const copy = await readFile(copyPath)
  const source = await open(sourcePath, 'r')
  try {
    const head = Buffer.alloc(copy.length)
    const { bytesRead } = await source.read(head, 0, copy.length, 0)
    return bytesRead === copy.length && head.equals(copy)
  } finally {
    await source.close()
  }
}
