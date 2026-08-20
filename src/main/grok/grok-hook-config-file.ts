import { randomUUID } from 'node:crypto'
import { link, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { parseHooksJsonText } from '../agent-hooks/hooks-json-read'
import type { HooksConfig } from '../agent-hooks/installer-utils'

const WINDOWS_RENAME_ATTEMPTS = 6

export type AsyncGrokHookConfigSnapshot = {
  raw: string | null
  config: HooksConfig | null
}

export async function readGrokHookConfigSnapshot(
  targetPath: string
): Promise<AsyncGrokHookConfigSnapshot> {
  try {
    const raw = await readFile(targetPath, 'utf8')
    return { raw, config: parseHooksJsonText(raw) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: null, config: {} }
    }
    throw error
  }
}

export async function writeGrokHookConfigIfUnchanged(
  targetPath: string,
  expectedContents: string,
  contents: string
): Promise<boolean> {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  const heldPath = guardedPath(targetPath)
  await recoverInterruptedMutation(heldPath, targetPath)
  try {
    await writeFile(tempPath, contents, 'utf8')
    await assertHardLinkPublicationSupported(tempPath, targetPath)
    if (!(await moveTargetToHeld(targetPath, heldPath))) {
      return false
    }
    if (!(await contentsEqual(heldPath, expectedContents))) {
      await restoreHeldWithoutOverwrite(heldPath, targetPath)
      return false
    }
    if (!(await publishWithoutOverwrite(tempPath, targetPath))) {
      await rm(heldPath, { force: true })
      return false
    }
    await rm(heldPath, { force: true })
    return true
  } catch (error) {
    await restoreHeldWithoutOverwrite(heldPath, targetPath)
    throw error
  } finally {
    await rm(tempPath, { force: true })
  }
}

export async function removeGrokHookConfigIfUnchanged(
  targetPath: string,
  expectedContents: string
): Promise<boolean> {
  const heldPath = guardedPath(targetPath)
  await recoverInterruptedMutation(heldPath, targetPath)
  try {
    await assertHardLinkPublicationSupported(targetPath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
  if (!(await moveTargetToHeld(targetPath, heldPath))) {
    return false
  }
  try {
    if (!(await contentsEqual(heldPath, expectedContents))) {
      await restoreHeldWithoutOverwrite(heldPath, targetPath)
      return false
    }
    await rm(heldPath, { force: true })
    return !(await pathExists(targetPath))
  } catch (error) {
    await restoreHeldWithoutOverwrite(heldPath, targetPath)
    throw error
  }
}

function guardedPath(targetPath: string): string {
  return `${targetPath}.orca-guarded`
}

async function recoverInterruptedMutation(heldPath: string, targetPath: string): Promise<void> {
  if (!(await pathExists(heldPath))) {
    return
  }
  await publishWithoutOverwrite(heldPath, targetPath)
  await rm(heldPath, { force: true })
}

async function restoreHeldWithoutOverwrite(heldPath: string, targetPath: string): Promise<void> {
  if (!(await pathExists(heldPath))) {
    return
  }
  await publishWithoutOverwrite(heldPath, targetPath)
  await rm(heldPath, { force: true })
}

async function assertHardLinkPublicationSupported(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  const probePath = `${targetPath}.${process.pid}.${randomUUID()}.link-probe`
  try {
    if (!(await publishWithoutOverwrite(sourcePath, probePath))) {
      throw new Error(`Guarded file publication probe already exists: ${probePath}`)
    }
  } finally {
    await rm(probePath, { force: true })
  }
}

async function publishWithoutOverwrite(sourcePath: string, targetPath: string): Promise<boolean> {
  try {
    await link(sourcePath, targetPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }
    throw error
  }
}

async function moveTargetToHeld(targetPath: string, heldPath: string): Promise<boolean> {
  try {
    await renameWithWindowsRetry(targetPath, heldPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function renameWithWindowsRetry(sourcePath: string, targetPath: string): Promise<void> {
  const attempts = process.platform === 'win32' ? WINDOWS_RENAME_ATTEMPTS : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(sourcePath, targetPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < attempts && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 50))
        continue
      }
      throw error
    }
  }
}

async function contentsEqual(targetPath: string, expectedContents: string): Promise<boolean> {
  return (await readFile(targetPath, 'utf8')) === expectedContents
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await readFile(targetPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}
