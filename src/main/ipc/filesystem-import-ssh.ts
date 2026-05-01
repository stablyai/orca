import { lstat, readdir } from 'fs/promises'
import { basename, join, posix, resolve } from 'path'
import type { SFTPWrapper } from 'ssh2'
import { authorizeExternalPath, isENOENT } from './filesystem-auth'
import { getSshConnectionManager } from './ssh'
import { uploadFile, uploadDirectory, mkdirSftp, sftpPathExists } from '../ssh/sftp-upload'
import type { ImportItemResult } from './filesystem-mutations'

// Why: the SSH import path bypasses SshFilesystemProvider and uses
// SshConnection.sftp() directly because the relay's JSON-RPC fs.writeFile
// is text-only and cannot carry binary data without base64 overhead.
export async function importExternalPathsSsh(
  sourcePaths: string[],
  destDir: string,
  connectionId: string
): Promise<{ results: ImportItemResult[] }> {
  if (sourcePaths.length === 0) {
    return { results: [] }
  }

  const connManager = getSshConnectionManager()
  const conn = connManager?.getConnection(connectionId)
  if (!conn) {
    throw new Error(`No SSH connection for "${connectionId}"`)
  }

  const state = conn.getState()
  if (state.status !== 'connected') {
    if (state.status === 'reconnecting') {
      throw new Error('SSH connection is reconnecting — please try again in a moment')
    }
    throw new Error('SSH connection is not active — please reconnect and try again')
  }

  const sftp = await conn.sftp()

  try {
    const results: ImportItemResult[] = []
    const reservedNames = new Set<string>()

    for (const sourcePath of sourcePaths) {
      const result = await importOneSourceSsh(sftp, sourcePath, destDir, reservedNames)
      results.push(result)
      if (result.status === 'imported') {
        // Why: destPath is a remote POSIX path (e.g. /home/user/foo/bar.txt).
        // Node's basename() uses the OS separator, which on Windows would
        // return the entire string instead of just the filename.
        reservedNames.add(posix.basename(result.destPath))
      }
    }

    return { results }
  } finally {
    sftp.end()
  }
}

async function importOneSourceSsh(
  sftp: SFTPWrapper,
  sourcePath: string,
  destDir: string,
  reservedNames: Set<string>
): Promise<ImportItemResult> {
  const resolvedSource = resolve(sourcePath)

  authorizeExternalPath(resolvedSource)

  let sourceStat: Awaited<ReturnType<typeof lstat>>
  try {
    sourceStat = await lstat(resolvedSource)
  } catch (error) {
    if (isENOENT(error)) {
      return { sourcePath, status: 'skipped', reason: 'missing' }
    }
    if (
      error instanceof Error &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'EACCES' ||
        (error as NodeJS.ErrnoException).code === 'EPERM')
    ) {
      return { sourcePath, status: 'skipped', reason: 'permission-denied' }
    }
    return {
      sourcePath,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  if (sourceStat.isSymbolicLink()) {
    return { sourcePath, status: 'skipped', reason: 'symlink' }
  }

  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    return { sourcePath, status: 'skipped', reason: 'unsupported' }
  }

  const isDir = sourceStat.isDirectory()

  if (isDir) {
    const hasSymlink = await preScanForSymlinks(resolvedSource)
    if (hasSymlink) {
      return { sourcePath, status: 'skipped', reason: 'symlink' }
    }
  }

  const originalName = basename(resolvedSource)

  try {
    const finalName = await deconflictNameSftp(sftp, destDir, originalName, reservedNames)
    const destPath = `${destDir}/${finalName}`
    const renamed = finalName !== originalName

    if (isDir) {
      await mkdirSftp(sftp, destPath)
      await uploadDirectory(sftp, resolvedSource, destPath)
    } else {
      await uploadFile(sftp, resolvedSource, destPath)
    }

    return {
      sourcePath,
      status: 'imported',
      destPath,
      kind: isDir ? 'directory' : 'file',
      renamed
    }
  } catch (error) {
    return {
      sourcePath,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

async function deconflictNameSftp(
  sftp: SFTPWrapper,
  destDir: string,
  originalName: string,
  reservedNames: Set<string>
): Promise<string> {
  if (
    !(await sftpPathExists(sftp, `${destDir}/${originalName}`)) &&
    !reservedNames.has(originalName)
  ) {
    return originalName
  }

  const dotIndex = originalName.lastIndexOf('.')
  const hasMeaningfulExt = dotIndex > 0
  const stem = hasMeaningfulExt ? originalName.slice(0, dotIndex) : originalName
  const ext = hasMeaningfulExt ? originalName.slice(dotIndex) : ''

  let candidate = `${stem} copy${ext}`
  if (!(await sftpPathExists(sftp, `${destDir}/${candidate}`)) && !reservedNames.has(candidate)) {
    return candidate
  }

  let counter = 2
  while (counter < 10000) {
    candidate = `${stem} copy ${counter}${ext}`
    if (!(await sftpPathExists(sftp, `${destDir}/${candidate}`)) && !reservedNames.has(candidate)) {
      return candidate
    }
    counter += 1
  }

  throw new Error(
    `Could not generate a unique name for '${originalName}' after ${counter} attempts`
  )
}

async function preScanForSymlinks(dirPath: string): Promise<boolean> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      return true
    }
    if (entry.isDirectory()) {
      const childPath = join(dirPath, entry.name)
      if (await preScanForSymlinks(childPath)) {
        return true
      }
    }
  }
  return false
}
