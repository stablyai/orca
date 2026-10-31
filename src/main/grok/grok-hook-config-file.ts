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

/** Remove managed configs only; symlinked user configs require stripping entries and writing through. */
export async function removeGrokHookConfigIfUnchanged(
  targetPath: string,
  expectedContents: string,
  options?: GrokHookConfigMutationOptions
): Promise<boolean> {
  return await mutateGrokHookConfigIfUnchanged(targetPath, expectedContents, null, options)
}

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
  // Resolve symlinks before moving so dotfile-managed configs stay connected.
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
    // Exclusive copy preserves concurrent writers and supports filesystems without hard links; retain heldPath until complete.
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
