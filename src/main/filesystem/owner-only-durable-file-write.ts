import { mkdir, open, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../shared/file-write/windows-retry-file-operations'
import {
  restrictWindowsDirectory,
  restrictWindowsFile
} from '../../shared/secure-storage/secure-path-windows-acl'
import { loadWindowsSecurity } from '../../shared/secure-storage/windows-security-addon'
import { durableWriteTempPath, syncDirectory } from './durable-file-write'

// Windows stages here: its owner-only DACL is inherited the moment a file is created, so no other
// user can open a staged file before it is restricted.
const WINDOWS_STAGING_FOLDER = '.owner-only-staging'
const stagingReady = new Map<string, Promise<string>>()

/** The async counterpart of writeSecureFile: the contents only ever land in a file other users can't
 *  read (0o600, or an owner-only DACL on Windows; without the Windows addon, a plain write as there).
 *  Throws, writing nothing, when Windows can't restrict it. */
export async function writeOwnerOnlyFileDurable(
  finalPath: string,
  contents: string
): Promise<void> {
  const directory = dirname(finalPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const windows = process.platform === 'win32'
  const tmpPath = windows
    ? durableWriteTempPath(join(await windowsStaging(directory), basename(finalPath)))
    : durableWriteTempPath(finalPath)
  let renamed = false
  try {
    const handle = await open(tmpPath, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Protected before it is published, so a later change to the parent's inheritance never reaches it.
    if (windows && !(await restrictWindowsFile(tmpPath)) && windowsSecurityLoaded()) {
      throw new Error(`Could not restrict ${tmpPath} to its owner`)
    }
    await renameFileWithWindowsRetryAsync(tmpPath, finalPath)
    renamed = true
    await syncDirectory(directory)
  } finally {
    if (!renamed) {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}

/** The directory's owner-only staging folder, restricted and swept of earlier runs' leftovers once. */
function windowsStaging(directory: string): Promise<string> {
  let ready = stagingReady.get(directory)
  if (!ready) {
    ready = prepareWindowsStaging(join(directory, WINDOWS_STAGING_FOLDER))
    stagingReady.set(directory, ready)
    // A failure is retried by the next write.
    ready.catch(() => stagingReady.delete(directory))
  }
  return ready
}

async function prepareWindowsStaging(staging: string): Promise<string> {
  await mkdir(staging, { recursive: true })
  if (!(await restrictWindowsDirectory(staging)) && windowsSecurityLoaded()) {
    throw new Error(`Could not restrict ${staging} to its owner`)
  }
  await removeStaleOwnerOnlyStaging(dirname(staging))
  return staging
}

/** Drops what earlier runs left staged for `directory`'s files; for a sign-out or deletion that
 *  writes nothing after. Only this process's own staged files are kept. */
export async function removeStaleOwnerOnlyStaging(directory: string): Promise<void> {
  const staging = join(directory, WINDOWS_STAGING_FOLDER)
  const own = `.${process.pid}.`
  for (const name of await readdir(staging).catch(() => [])) {
    if (name.endsWith('.tmp') && !name.includes(own)) {
      await rm(join(staging, name), { force: true }).catch(() => {})
    }
  }
}

const windowsSecurityLoaded = (): boolean => !('error' in loadWindowsSecurity())
