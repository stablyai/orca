import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeImportLimits from './runtime-import-limits'

type RuntimeImportLimitsModule = typeof RuntimeImportLimits

const callRuntimeEnvironment = vi.fn()

vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: (...args: unknown[]) => callRuntimeEnvironment(...args)
}))
vi.mock('./filesystem-auth', () => ({ authorizeExternalPath: () => {} }))
// Why: see filesystem-runtime-upload-staging.test.ts — a real over-limit fixture
// would allocate gigabytes on Windows.
vi.mock('./runtime-import-limits', async (importOriginal) => ({
  ...(await importOriginal<RuntimeImportLimitsModule>()),
  REMOTE_IMPORT_MAX_FILE_BYTES: 2 * 1024 * 1024
}))

const { RUNTIME_UPLOAD_SLICE_BYTES, streamExternalFileToRuntime } =
  await import('./runtime-upload-file-stream')

let workDir: string

type ChunkCall = { relativePath: string; contentBase64: string; append: boolean }

function chunkCalls(): ChunkCall[] {
  return callRuntimeEnvironment.mock.calls
    .filter(([, , method]) => method === 'files.writeBase64Chunk')
    .map(([, , , params]) => params as ChunkCall)
}

function uploadedBytes(): Buffer {
  return Buffer.concat(chunkCalls().map((call) => Buffer.from(call.contentBase64, 'base64')))
}

function baseArgs(sourceRootPath: string) {
  return {
    userDataPath: '/user-data',
    environmentId: 'env-1',
    sourceRootPath,
    entryRelativePath: '',
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
  it('sends a file larger than the old 25 MB cap as ordered append-only slices', async () => {
    const size = RUNTIME_UPLOAD_SLICE_BYTES * 2 + 1234
    const contents = Buffer.alloc(size)
    for (let index = 0; index < size; index += 1) {
      contents[index] = index % 251
    }
    const filePath = join(workDir, 'big.bin')
    await writeFile(filePath, contents)

    await expect(streamExternalFileToRuntime(baseArgs(filePath))).resolves.toEqual({
      byteLength: size
    })

    const calls = chunkCalls()
    expect(calls).toHaveLength(3)
    expect(calls.map((call) => call.append)).toEqual([false, true, true])
    expect(uploadedBytes().equals(contents)).toBe(true)
  })

  it('refuses a source whose size no longer matches what staging measured', async () => {
    const filePath = join(workDir, 'grown.bin')
    await writeFile(filePath, Buffer.alloc(2048))

    await expect(
      streamExternalFileToRuntime({ ...baseArgs(filePath), expectedByteLength: 1024 })
    ).rejects.toThrow('File changed since it was staged')
    expect(chunkCalls()).toHaveLength(0)
  })

  it('accepts a source that still matches its staged size', async () => {
    const filePath = join(workDir, 'same.bin')
    await writeFile(filePath, Buffer.alloc(2048))

    await expect(
      streamExternalFileToRuntime({ ...baseArgs(filePath), expectedByteLength: 2048 })
    ).resolves.toEqual({ byteLength: 2048 })
  })

  it('refuses a file over the ceiling even when no staged size is supplied', async () => {
    const filePath = join(workDir, 'huge.bin')
    await writeFile(filePath, Buffer.alloc(3 * 1024 * 1024))

    await expect(streamExternalFileToRuntime(baseArgs(filePath))).rejects.toThrow(
      'over the 2 MB per-file remote import limit'
    )
    expect(chunkCalls()).toHaveLength(0)
  })

  it('never buffers more than one slice per chunk', async () => {
    const filePath = join(workDir, 'sliced.bin')
    await writeFile(filePath, Buffer.alloc(RUNTIME_UPLOAD_SLICE_BYTES * 2))

    await streamExternalFileToRuntime(baseArgs(filePath))

    for (const call of chunkCalls()) {
      expect(Buffer.from(call.contentBase64, 'base64').byteLength).toBeLessThanOrEqual(
        RUNTIME_UPLOAD_SLICE_BYTES
      )
    }
  })

  it('creates an empty destination for a zero-byte source', async () => {
    const filePath = join(workDir, 'empty.txt')
    await writeFile(filePath, '')

    await expect(streamExternalFileToRuntime(baseArgs(filePath))).resolves.toEqual({
      byteLength: 0
    })

    expect(chunkCalls()).toEqual([expect.objectContaining({ append: false, contentBase64: '' })])
  })

  it('carries the pairing revision on every chunk so a re-pair cannot finish the file', async () => {
    const filePath = join(workDir, 'guarded.bin')
    await writeFile(filePath, Buffer.alloc(RUNTIME_UPLOAD_SLICE_BYTES + 10))

    await streamExternalFileToRuntime({
      ...baseArgs(filePath),
      expectedEnvironmentPairingRevision: 41
    })

    const revisions = callRuntimeEnvironment.mock.calls
      .filter(([, , method]) => method === 'files.writeBase64Chunk')
      .map(([, , , , , revision]) => revision)
    expect(revisions).toHaveLength(2)
    expect(revisions).toEqual([41, 41])
  })

  it('stops at the failing chunk instead of sending the rest of the file', async () => {
    const filePath = join(workDir, 'fails.bin')
    await writeFile(filePath, Buffer.alloc(RUNTIME_UPLOAD_SLICE_BYTES * 3))
    callRuntimeEnvironment.mockResolvedValueOnce({ id: 'x', ok: true, result: {}, _meta: {} })
    callRuntimeEnvironment.mockResolvedValueOnce({
      id: 'x',
      ok: false,
      error: { code: 'write_failed', message: 'disk full' }
    })

    await expect(streamExternalFileToRuntime(baseArgs(filePath))).rejects.toThrow('disk full')
    expect(chunkCalls()).toHaveLength(2)
  })

  // symlink() needs privileges or Developer Mode on Windows.
  it.skipIf(process.platform === 'win32')('refuses a symlinked source', async () => {
    const targetPath = join(workDir, 'secret.txt')
    await writeFile(targetPath, 'secret')
    const linkPath = join(workDir, 'link.txt')
    await symlink(targetPath, linkPath)

    await expect(streamExternalFileToRuntime(baseArgs(linkPath))).rejects.toThrow(
      'Symlink not allowed'
    )
    expect(chunkCalls()).toHaveLength(0)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a directory entry whose real path escapes the dropped root',
    async () => {
      const outsidePath = join(workDir, 'outside.txt')
      await writeFile(outsidePath, 'outside')
      const rootPath = join(workDir, 'root')
      await mkdir(rootPath)
      await symlink(outsidePath, join(rootPath, 'escape.txt'))

      await expect(
        streamExternalFileToRuntime({
          ...baseArgs(rootPath),
          entryRelativePath: 'escape.txt'
        })
      ).rejects.toThrow('Symlink not allowed')
      expect(chunkCalls()).toHaveLength(0)
    }
  )
})
