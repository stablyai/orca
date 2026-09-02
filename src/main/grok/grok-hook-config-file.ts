import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { parseHooksJsonText } from '../agent-hooks/hooks-json-read'
import type { HooksConfig } from '../agent-hooks/installer-utils'

export type AsyncGrokHookConfigSnapshot = {
  raw: string | null
  config: HooksConfig | null
}

export async function readGrokHookConfigSnapshot(
  targetPath: string
): Promise<AsyncGrokHookConfigSnapshot> {
  const raw = await readFileOrNull(targetPath)
  return raw === null ? { raw: null, config: {} } : { raw, config: parseHooksJsonText(raw) }
}

export async function writeGrokHookConfigIfUnchanged(
  targetPath: string,
  expectedContents: string,
  contents: string,
  options?: GrokHookConfigMutationOptions
): Promise<boolean> {
  return await mutateGrokHookConfigIfUnchanged(targetPath, expectedContents, contents, options)
}

/**
 * Removes the managed config. Returns false when the caller must write through instead: a config
 * the user has symlinked belongs to them, so we strip our entries rather than unlink their link.
 */
export async function removeGrokHookConfigIfUnchanged(
  targetPath: string,
  expectedContents: string,
  options?: GrokHookConfigMutationOptions
): Promise<boolean> {
  return await mutateGrokHookConfigIfUnchanged(targetPath, expectedContents, null, options)
}

/** True when the config is a symlink, so it must be written through and never unlinked. */
export async function isGrokHookConfigSymlink(targetPath: string): Promise<boolean> {
  try {
    return (await lstat(targetPath)).isSymbolicLink()
  } catch {
    return false
  }
}

async function resolveWriteTarget(targetPath: string): Promise<string> {
  return (await isGrokHookConfigSymlink(targetPath)) ? await realpath(targetPath) : targetPath
}

async function mutateGrokHookConfigIfUnchanged(
  targetPath: string,
  expectedContents: string,
  contents: string | null,
  options?: GrokHookConfigMutationOptions
): Promise<boolean> {
  if (options?.beforeHold && !(await options.beforeHold())) {
    return false
  }
  // Why resolve first: moving the link path would detach a config kept in the user's dotfiles.
  const writePath = await resolveWriteTarget(targetPath)
  const heldPath = `${writePath}.${process.pid}.${randomUUID()}.held`
  try {
    await rename(writePath, heldPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }

  let restoreOnFailure = true
  try {
    if ((await readFileOrNull(heldPath)) !== expectedContents) {
      restoreOnFailure = false
      await restoreHeldFile(heldPath, writePath)
      return false
    }
    if (options?.shouldCommit && !(await options.shouldCommit())) {
      restoreOnFailure = false
      await restoreHeldFile(heldPath, writePath)
      return false
    }
    if ((await readFileOrNull(writePath)) !== null) {
      // A concurrent writer published a newer generation while the old one was held.
      restoreOnFailure = false
      await rm(heldPath, { force: true })
      return false
    }
    if (contents === null) {
      restoreOnFailure = false
      await rm(heldPath, { force: true })
      return true
    }

    const mode = (await stat(heldPath)).mode
    let handle
    try {
      handle = await open(writePath, 'wx', mode)
      await handle.writeFile(contents, 'utf8')
      await handle.chmod(mode)
      await handle.sync()
    } catch (error) {
      await handle?.close().catch(() => {})
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await rm(heldPath, { force: true })
        return false
      }
      await rm(writePath, { force: true })
      throw error
    }
    await handle.close()
    restoreOnFailure = false
    await rm(heldPath, { force: true })
    return true
  } catch (error) {
    if (restoreOnFailure) {
      await restoreHeldFile(heldPath, writePath)
    }
    throw error
  }
}

async function restoreHeldFile(heldPath: string, targetPath: string): Promise<void> {
  try {
    // Why exclusive copy: it never overwrites a concurrent writer and works on Windows/network
    // filesystems that do not support hard links. Keep heldPath until the complete copy succeeds.
    await copyFile(heldPath, targetPath, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      // Preserve the held file as the only complete generation when restoration itself fails.
      throw error
    }
  }
  await rm(heldPath, { force: true })
}

type GrokHookConfigMutationOptions = {
  /** Slow ownership work runs before the live config is moved out of place. */
  beforeHold?: () => Promise<boolean>
  /** Fast generation check that closes the gap after ownership was released. */
  shouldCommit?: () => Promise<boolean>
}

async function readFileOrNull(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}
