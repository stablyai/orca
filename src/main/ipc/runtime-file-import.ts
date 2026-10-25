import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import { z } from 'zod'
import type { RuntimeFileImportRequest } from '../../shared/runtime-file-import-request'
import type { ImportItemResult } from '../../shared/filesystem-import-result-types'
import { importOneSource } from './filesystem-import-local'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  RUNTIME_MANUALLY_DISCONNECTED_MESSAGE
} from './runtime-environments/runtime-environment-manual-disconnect'
import {
  REMOTE_IMPORT_MAX_FILE_BYTES,
  REMOTE_IMPORT_MAX_TOTAL_BYTES
} from './runtime-import-limits'
import { sanitizeLocalDownloadFilename } from '../local-download-filename'

const CHUNK_BYTES = 384 * 1024
const directoryEntries = z.array(
  z.object({
    name: z.string(),
    isDirectory: z.boolean(),
    isSymlink: z.boolean()
  })
)
const fileStat = z.object({
  size: z.number().int().nonnegative(),
  isDirectory: z.boolean(),
  mtime: z.number()
})
const fileChunk = z.object({
  contentBase64: z.string().max(4 * Math.ceil(CHUNK_BYTES / 3)),
  bytesRead: z.number().int().min(0).max(CHUNK_BYTES),
  eof: z.boolean()
})

export async function importRuntimeFiles(
  request: RuntimeFileImportRequest,
  userDataPath: string,
  tempDir: string,
  signal: AbortSignal
): Promise<{ results: ImportItemResult[] }> {
  let runtimeId: string | undefined
  let totalBytes = 0
  let entryCount = 0
  const results: ImportItemResult[] = []
  const reservedNames = new Set<string>()

  async function read(method: string, relativePath: string, extra = {}): Promise<unknown> {
    signal.throwIfAborted()
    if (isRuntimeEnvironmentManuallyDisconnected(request.environmentId)) {
      throw new Error(RUNTIME_MANUALLY_DISCONNECTED_MESSAGE)
    }
    const response = await callRuntimeEnvironment(
      userDataPath,
      request.environmentId,
      method,
      { worktree: request.worktree, relativePath, ...extra },
      60_000,
      request.expectedEnvironmentPairingRevision,
      undefined,
      { signal, expectedEnvironmentRuntimeId: runtimeId }
    )
    if (!response.ok) {
      throw new Error(
        response.error.code === 'method_not_found'
          ? 'Copying remote files requires a newer Orca server. Update the server and try again.'
          : response.error.message
      )
    }
    if (runtimeId && runtimeId !== response._meta.runtimeId) {
      throw new Error('Remote server changed during copy')
    }
    runtimeId ??= response._meta.runtimeId
    signal.throwIfAborted()
    return response.result
  }

  async function download(relativePath: string, destination: string, depth: number): Promise<void> {
    if (++entryCount > 100_000 || depth > 128) {
      throw new Error('Folder exceeds the remote import entry or depth limit')
    }
    const before = fileStat.parse(await read('files.stat', relativePath))
    if (before.isDirectory) {
      await mkdir(destination)
      const entries = directoryEntries.parse(
        await read('files.readDir', relativePath, { followSymlinks: false })
      )
      for (const entry of entries) {
        assertLocalName(entry.name)
        if (entry.isSymlink) {
          throw new Error(`Cannot copy symbolic link '${entry.name}'`)
        }
        await download(
          posix.join(relativePath, entry.name),
          join(destination, entry.name),
          depth + 1
        )
      }
      return
    }
    if (
      before.size > REMOTE_IMPORT_MAX_FILE_BYTES ||
      totalBytes + before.size > REMOTE_IMPORT_MAX_TOTAL_BYTES
    ) {
      throw new Error('Files exceed the remote import size limit')
    }
    totalBytes += before.size
    const handle = await open(destination, 'wx')
    try {
      let offset = 0
      for (;;) {
        const chunk = fileChunk.parse(
          await read('files.readChunk', relativePath, { offset, length: CHUNK_BYTES })
        )
        const bytes = Buffer.from(chunk.contentBase64, 'base64')
        if (
          bytes.length !== chunk.bytesRead ||
          offset + bytes.length > before.size ||
          (!chunk.eof && bytes.length === 0)
        ) {
          throw new Error('Remote file changed or returned an invalid chunk')
        }
        await handle.writeFile(bytes)
        offset += bytes.length
        if (chunk.eof) {
          if (offset !== before.size) {
            throw new Error('Remote file changed during copy')
          }
          break
        }
      }
      const after = fileStat.parse(await read('files.stat', relativePath))
      if (after.isDirectory || before.size !== after.size || before.mtime !== after.mtime) {
        throw new Error('Remote file changed during copy')
      }
    } finally {
      await handle.close()
    }
  }

  for (const relativePath of request.relativePaths) {
    let stagingDir: string | undefined
    try {
      const parts = relativePath.split('/')
      if (!relativePath || parts.some((part) => !part || part === '.' || part === '..')) {
        throw new Error('Invalid remote source path')
      }
      const name = posix.basename(relativePath)
      assertLocalName(name)
      const siblings = directoryEntries.parse(
        await read(
          'files.readDir',
          posix.dirname(relativePath) === '.' ? '' : posix.dirname(relativePath),
          { followSymlinks: false }
        )
      )
      const entry = siblings.find((item) => item.name === name)
      if (!entry || entry.isSymlink) {
        throw new Error(entry ? 'Cannot copy symbolic links' : 'Remote source no longer exists')
      }
      stagingDir = await mkdtemp(join(tempDir, 'orca-file-import-'))
      const stagedPath = join(stagingDir, name)
      await download(relativePath, stagedPath, 0)
      signal.throwIfAborted()
      const result = await importOneSource(stagedPath, request.destinationDir, reservedNames)
      results.push({ ...result, sourcePath: relativePath })
      if (result.status === 'imported') {
        reservedNames.add(basename(result.destPath))
      }
    } catch (error) {
      results.push({
        sourcePath: relativePath,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (stagingDir) {
        await rm(stagingDir, { recursive: true, force: true })
      }
    }
    signal.throwIfAborted()
  }
  return { results }
}

function assertLocalName(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0') ||
    (process.platform === 'win32' && sanitizeLocalDownloadFilename(name) !== name)
  ) {
    throw new Error(`Filename cannot be copied to this computer: '${name}'`)
  }
}
