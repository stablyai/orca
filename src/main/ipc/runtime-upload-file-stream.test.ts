import { lstat, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StagedRuntimeUploadFileIdentity } from '../../shared/file-import/runtime-upload-staging-contract'
import type * as RuntimeImportLimits from './runtime-import-limits'

type RuntimeImportLimitsModule = typeof RuntimeImportLimits

type ChunkCall = {
  relativePath: string
  contentBase64: string
  append: boolean
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExecutionHostId?: string
}
type RuntimeCallOptions = { expectedEnvironmentRuntimeId?: string; signal?: AbortSignal }

const callRuntimeEnvironment =
  vi.fn<
    (
      userDataPath: string,
      environmentId: string,
      method: string,
      params: ChunkCall,
      timeoutMs?: number,
      expectedEnvironmentPairingRevision?: number,
      envelope?: unknown,
      options?: RuntimeCallOptions
    ) => unknown
  >()

vi.mock('./runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: (...args: Parameters<typeof callRuntimeEnvironment>) =>
    callRuntimeEnvironment(...args)
}))
// Lower test caps avoid allocating gigabytes on Windows; see filesystem/filesystem-runtime-upload-staging.test.ts.
vi.mock('./runtime-import-limits', async (importOriginal) => ({
  ...(await importOriginal<RuntimeImportLimitsModule>()),
  REMOTE_IMPORT_MAX_FILE_BYTES: 2 * 1024 * 1024
}))

const { RUNTIME_UPLOAD_SLICE_BYTES, streamExternalFileToRuntime } =
  await import('./runtime-upload-file-stream')
await import('./runtime-environments/connectivity/runtime-environment-manual-disconnect')

let workDir: string

/** Measure the same source identity as production staging. */
async function stagedIdentity(filePath: string): Promise<StagedRuntimeUploadFileIdentity> {
  const stat = await lstat(filePath)
  return {
    byteLength: stat.size,
    inode: stat.ino,
    deviceId: stat.dev,
    modifiedAtMs: stat.mtimeMs
  }
}

async function baseArgs(sourceRootPath: string, entryPath?: string) {
  return {
    userDataPath: '/user-data',
    environmentId: 'env-1',
    sourceRootPath,
    entryRelativePath: entryPath ?? '',
    expected: await stagedIdentity(entryPath ? join(sourceRootPath, entryPath) : sourceRootPath),
    worktree: 'wt-1',
    relativePath: '.upload.tmp'
  }
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orca-upload-stream-'))
  callRuntimeEnvironment.mockReset()
  callRuntimeEnvironment.mockResolvedValue({ id: 'x', ok: true, result: {}, _meta: {} })
})

afterEach(async () => {
  await rm(workDir, { force: true, recursive: true })
})

describe('streamExternalFileToRuntime', () => {
  it('aborts when the source is rewritten at the same size mid-transfer', async () => {
    const filePath = join(workDir, 'racing.bin')
    const size = RUNTIME_UPLOAD_SLICE_BYTES * 2
    await writeFile(filePath, Buffer.alloc(size, 0x41))
    const args = await baseArgs(filePath)

    let rewritten = false
    callRuntimeEnvironment.mockImplementation(async () => {
      if (!rewritten) {
        rewritten = true
        await writeFile(filePath, Buffer.alloc(size, 0x42))
        const bumped = new Date(args.expected.modifiedAtMs + 5_000)
        await utimes(filePath, bumped, bumped)
      }
      return { id: 'x', ok: true, result: {}, _meta: {} }
    })

    await expect(streamExternalFileToRuntime(args)).rejects.toThrow('File changed during upload')
  })

  it('refuses to finish a zero-byte upload whose source gained content mid-write', async () => {
    const filePath = join(workDir, 'grows.txt')
    await writeFile(filePath, '')
    const args = await baseArgs(filePath)

    callRuntimeEnvironment.mockImplementation(async () => {
      await writeFile(filePath, 'content arrived during the empty write')
      return { id: 'x', ok: true, result: {}, _meta: {} }
    })

    await expect(streamExternalFileToRuntime(args)).rejects.toThrow('File changed during upload')
  })

  // symlink() needs privileges or Developer Mode on Windows.
})
