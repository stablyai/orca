import { randomUUID } from 'node:crypto'
import { link, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../shared/file-write/windows-retry-file-operations'
import { grantDirAclAsync } from '../windows/windows-directory-acl'
import { getGuardedOperationHeldPath } from './atomic-file-publication'
import { isPermissionError } from './permission-errors'

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function linkWithoutOverwrite(source: string, target: string): Promise<boolean> {
  try {
    await link(source, target)
    return true
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      return false
    }
    throw error
  }
}

async function restoreHeldFile(held: string, target: string): Promise<void> {
  try {
    await linkWithoutOverwrite(held, target)
    await rm(held, { force: true })
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error
    }
  }
}

async function publish(
  target: string,
  expected: string | null,
  contents: string
): Promise<boolean> {
  const held = getGuardedOperationHeldPath(target)
  const stage = `${target}.${randomUUID()}.tmp`
  await restoreHeldFile(held, target)
  try {
    await writeFile(stage, contents, { flag: 'wx', mode: 0o600 })
    if (expected === null) {
      return await linkWithoutOverwrite(stage, target)
    }
    // Probe before moving the original: the same filesystem must support an exclusive link.
    const probe = `${stage}.link-probe`
    await link(stage, probe)
    await rm(probe, { force: true })
    try {
      await renameFileWithWindowsRetryAsync(target, held)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        return false
      }
      throw error
    }
    if ((await readFile(held, 'utf8')) !== expected) {
      await restoreHeldFile(held, target)
      return false
    }
    const published = await linkWithoutOverwrite(stage, target)
    await rm(held, { force: true })
    return published
  } catch (error) {
    await restoreHeldFile(held, target)
    throw error
  } finally {
    await rm(stage, { force: true })
  }
}

/** Publish only if the generation moved aside still matches the editor's snapshot. */
export async function writeFileAtomicallyIfUnchangedAsync(
  target: string,
  expected: string | null,
  contents: string
): Promise<boolean> {
  try {
    return await publish(target, expected, contents)
  } catch (error) {
    if (process.platform !== 'win32' || !isPermissionError(error)) {
      throw error
    }
    await grantDirAclAsync(dirname(target))
    return publish(target, expected, contents)
  }
}
