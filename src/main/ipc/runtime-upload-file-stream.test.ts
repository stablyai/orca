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

vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
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
await import('./runtime-environments/runtime-environment-manual-disconnect')

let workDir: string

function chunkCalls(): ChunkCall[] {
  return callRuntimeEnvironment.mock.calls
    .filter(([, , method]) => method === 'files.writeBase64Chunk')
    .map(([, , , params]) => params)
}

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

  it('reports monotonic progress that ends on the file size', async () => {
    const size = RUNTIME_UPLOAD_SLICE_BYTES * 2 + 500
    const filePath = join(workDir, 'tracked.bin')
    await writeFile(filePath, Buffer.alloc(size))
    const seen: { sentBytes: number; totalBytes: number }[] = []

    await streamExternalFileToRuntime({
      ...(await baseArgs(filePath)),
      onProgress: (progress) => seen.push(progress)
    })

    expect(seen).toHaveLength(3)
    expect(seen.every((p) => p.totalBytes === size)).toBe(true)
    expect(seen.map((p) => p.sentBytes)).toEqual([
      RUNTIME_UPLOAD_SLICE_BYTES,
      RUNTIME_UPLOAD_SLICE_BYTES * 2,
      size
    ])
  })

  it('reports a zero-byte file as complete rather than never reporting', async () => {
    const filePath = join(workDir, 'nothing.txt')
    await writeFile(filePath, '')
    const seen: { sentBytes: number; totalBytes: number }[] = []

    await streamExternalFileToRuntime({
      ...(await baseArgs(filePath)),
      onProgress: (progress) => seen.push(progress)
    })

    expect(seen).toEqual([{ sentBytes: 0, totalBytes: 0 }])
  })

  it('stops reporting progress at the chunk that failed', async () => {
    const filePath = join(workDir, 'halts.bin')
    await writeFile(filePath, Buffer.alloc(RUNTIME_UPLOAD_SLICE_BYTES * 3))
    const seen: number[] = []
    callRuntimeEnvironment.mockResolvedValueOnce({ id: 'x', ok: true, result: {}, _meta: {} })
    callRuntimeEnvironment.mockResolvedValueOnce({
      id: 'x',
      ok: false,
      error: { code: 'write_failed', message: 'disk full' }
    })

    await expect(
      streamExternalFileToRuntime({
        ...(await baseArgs(filePath)),
        onProgress: (progress) => seen.push(progress.sentBytes)
      })
    ).rejects.toThrow('disk full')

    expect(seen).toEqual([RUNTIME_UPLOAD_SLICE_BYTES])
  })

  it('stops between slices when the cancel signal is already aborted', async () => {
    const filePath = join(workDir, 'aborted.bin')
    await writeFile(filePath, Buffer.alloc(RUNTIME_UPLOAD_SLICE_BYTES * 2))
    const controller = new AbortController()
    controller.abort()

    await expect(
      streamExternalFileToRuntime({
        ...(await baseArgs(filePath)),
        cancelSignal: controller.signal
      })
    ).rejects.toThrow('Upload cancelled')
    expect(chunkCalls()).toHaveLength(0)
  })

  it('stops mid-file when the cancel signal aborts after the first slice', async () => {
    const filePath = join(workDir, 'midway.bin')
    await writeFile(filePath, Buffer.alloc(RUNTIME_UPLOAD_SLICE_BYTES * 4))
    const controller = new AbortController()
    callRuntimeEnvironment.mockImplementation(async () => {
      controller.abort()
      return { id: 'x', ok: true, result: {}, _meta: {} }
    })

    await expect(
      streamExternalFileToRuntime({
        ...(await baseArgs(filePath)),
        cancelSignal: controller.signal
      })
    ).rejects.toThrow('Upload cancelled')
    // The first slice was already in flight; the loop stops before the second.
    expect(chunkCalls()).toHaveLength(1)
    // A cancel must let the in-flight append land before the renderer deletes the temp path.
    const [, , , , , , , options] = callRuntimeEnvironment.mock.calls[0]!
    expect(options?.signal).not.toBe(controller.signal)
  })

  it.each([
    ['the last slice', RUNTIME_UPLOAD_SLICE_BYTES * 2, 2],
    ['an empty file', 0, 1]
  ])(
    'rejects when the cancel lands during %s so the renderer never commits',
    async (_label, byteLength, chunkCount) => {
      const filePath = join(workDir, 'final-write.bin')
      await writeFile(filePath, Buffer.alloc(byteLength))
      const controller = new AbortController()
      callRuntimeEnvironment.mockImplementation(async () => {
        if (chunkCalls().length === chunkCount) {
          controller.abort()
        }
        return { id: 'x', ok: true, result: {}, _meta: {} }
      })

      await expect(
        streamExternalFileToRuntime({
          ...(await baseArgs(filePath)),
          cancelSignal: controller.signal
        })
      ).rejects.toThrow('Upload cancelled')
      expect(chunkCalls()).toHaveLength(chunkCount)
    }
  )

  // symlink() needs privileges or Developer Mode on Windows.
})
