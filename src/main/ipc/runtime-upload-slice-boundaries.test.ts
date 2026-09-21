import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileWriteBase64Chunk } from '../../shared/rpc-contract/files-mutation-params'
import type { StagedRuntimeUploadFileIdentity } from '../../shared/runtime-upload-staging-contract'

// Why: real limits, real host write flags ('wx' then 'a') and the real chunk
// schema — the slice loop is exercised exactly at the boundaries it must respect.
vi.mock('./filesystem-auth', () => ({ authorizeExternalPath: () => {} }))

type ChunkParams = { relativePath: string; contentBase64: string; append: boolean }
type CallOptions = { expectedEnvironmentRuntimeId?: string; signal?: AbortSignal }
type CallArgs = [
  userDataPath: string,
  environmentId: string,
  method: string,
  params: ChunkParams,
  timeoutMs?: number,
  expectedEnvironmentPairingRevision?: number,
  envelope?: unknown,
  options?: CallOptions
]

const callRuntimeEnvironment = vi.fn<(...args: CallArgs) => Promise<unknown>>()
// Why: vi.fn retains every call's params; a 2 GiB stream would pin ~2.8 GB of
// base64 in mock.calls and masquerade as a leak. Big tests swap in a plain fn.
let transportImpl: (...args: CallArgs) => Promise<unknown> = (...args) =>
  callRuntimeEnvironment(...args)
vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: (...args: CallArgs) => transportImpl(...args)
}))

const { RUNTIME_UPLOAD_SLICE_BYTES, streamExternalFileToRuntime } =
  await import('./runtime-upload-file-stream')
const { stageOneSourceForRuntimeUpload } = await import('./filesystem-runtime-upload-staging')
const { REMOTE_IMPORT_MAX_FILE_BYTES, REMOTE_IMPORT_MAX_TOTAL_BYTES, formatByteCeiling } =
  await import('./runtime-import-limits')

const SLICE = RUNTIME_UPLOAD_SLICE_BYTES
const WIRE_CHUNK_CHARS = 512 * 1024
const OK = { id: 'x', ok: true, result: {}, _meta: {} }

let workDir: string
let remoteDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'orca-upload-bounds-'))
  remoteDir = join(workDir, 'remote')
  await mkdir(remoteDir)
  callRuntimeEnvironment.mockReset()
  callRuntimeEnvironment.mockResolvedValue(OK)
  transportImpl = (...args) => callRuntimeEnvironment(...args)
})

afterEach(async () => {
  await rm(workDir, { force: true, recursive: true })
})

function chunkCalls(): ChunkParams[] {
  return callRuntimeEnvironment.mock.calls
    .filter(([, , method]) => method === 'files.writeBase64Chunk')
    .map(([, , , params]) => params)
}

/** Mirrors the host: first chunk is an exclusive create, appends open with 'a'. */
function installRealHostWrites(): void {
  callRuntimeEnvironment.mockImplementation(async (_u, _e, method, params) => {
    if (method === 'files.writeBase64Chunk') {
      const parsed = FileWriteBase64Chunk.parse({ worktree: 'wt-1', ...params })
      await writeFile(
        join(remoteDir, parsed.relativePath),
        Buffer.from(parsed.contentBase64, 'base64'),
        {
          flag: parsed.append ? 'a' : 'wx'
        }
      )
    }
    return OK
  })
}

async function identityOf(path: string): Promise<StagedRuntimeUploadFileIdentity> {
  const s = await stat(path)
  return { byteLength: s.size, inode: s.ino, deviceId: s.dev, modifiedAtMs: s.mtimeMs }
}

async function argsFor(sourceRootPath: string, entryRelativePath = '', relativePath = 'dest.tmp') {
  const target = entryRelativePath ? join(sourceRootPath, entryRelativePath) : sourceRootPath
  return {
    userDataPath: '/user-data',
    environmentId: 'env-1',
    sourceRootPath,
    entryRelativePath,
    expected: await identityOf(target),
    worktree: 'wt-1',
    relativePath,
    expectedEnvironmentPairingRevision: 7,
    expectedEnvironmentRuntimeId: 'rt-1'
  }
}

function patterned(size: number, seed: number): Buffer {
  const buffer = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i += 1) {
    buffer[i] = (i * 31 + seed) & 0xff
  }
  return buffer
}

describe('slice boundaries', () => {
  const sizes = [
    1,
    2,
    3,
    4,
    SLICE - 1,
    SLICE,
    SLICE + 1,
    2 * SLICE - 1,
    2 * SLICE,
    2 * SLICE + 1,
    3 * SLICE + 7
  ]

  for (const size of sizes) {
    it(`streams ${size} bytes as ceil(size/slice) schema-valid chunks that the host reassembles exactly`, async () => {
      installRealHostWrites()
      const contents = patterned(size, size)
      const source = join(workDir, `s-${size}.bin`)
      await writeFile(source, contents)
      const dest = `dest-${size}.tmp`

      await expect(streamExternalFileToRuntime(await argsFor(source, '', dest))).resolves.toEqual({
        byteLength: size
      })

      const calls = chunkCalls()
      const expectedChunks = Math.ceil(size / SLICE)
      expect(calls).toHaveLength(expectedChunks)
      expect(calls.map((c) => c.append)).toEqual(calls.map((_, i) => i > 0))
      for (const [index, call] of calls.entries()) {
        const isLast = index === calls.length - 1
        expect(call.contentBase64.length).toBeLessThanOrEqual(WIRE_CHUNK_CHARS)
        if (!isLast) {
          expect(call.contentBase64.length).toBe(WIRE_CHUNK_CHARS)
        }
        expect(call.relativePath).toBe(dest)
      }
      const remote = await readFile(join(remoteDir, dest))
      expect(remote.equals(contents)).toBe(true)
    })
  }

  it('sends a zero-byte file as one empty exclusive create the host schema accepts', async () => {
    installRealHostWrites()
    const source = join(workDir, 'empty.bin')
    await writeFile(source, '')

    await expect(
      streamExternalFileToRuntime(await argsFor(source, '', 'empty.tmp'))
    ).resolves.toEqual({
      byteLength: 0
    })
    expect(chunkCalls()).toHaveLength(1)
    expect(chunkCalls()[0]).toMatchObject({
      relativePath: 'empty.tmp',
      contentBase64: '',
      append: false
    })
    expect((await stat(join(remoteDir, 'empty.tmp'))).size).toBe(0)
  })

  it('carries the pairing revision, runtime id and signal on every chunk', async () => {
    const source = join(workDir, 'guards.bin')
    await writeFile(source, patterned(2 * SLICE + 1, 3))

    await streamExternalFileToRuntime(await argsFor(source))

    const chunkInvocations = callRuntimeEnvironment.mock.calls.filter(
      ([, , method]) => method === 'files.writeBase64Chunk'
    )
    expect(chunkInvocations).toHaveLength(3)
    for (const [, environmentId, , , timeoutMs, revision, envelope, options] of chunkInvocations) {
      expect(environmentId).toBe('env-1')
      expect(timeoutMs).toBe(30_000)
      expect(revision).toBe(7)
      expect(envelope).toBeUndefined()
      expect(options?.expectedEnvironmentRuntimeId).toBe('rt-1')
    }
  })
})

describe('staging → streaming end to end on a real filesystem', () => {
  it('streams every staged entry of a dropped directory using the identity staging recorded', async () => {
    installRealHostWrites()
    const root = join(workDir, 'drop me')
    await mkdir(join(root, 'sub', 'deeper'), { recursive: true })
    const files: Record<string, Buffer> = {
      'a.txt': Buffer.from('alpha'),
      '..keep': Buffer.from('dot-dot-prefixed name is a valid child'),
      'héllo wörld.bin': patterned(SLICE, 9),
      'sub/empty': Buffer.alloc(0),
      'sub/deeper/big.bin': patterned(2 * SLICE + 5, 11)
    }
    for (const [rel, body] of Object.entries(files)) {
      await writeFile(join(root, rel), body)
    }

    const staged = await stageOneSourceForRuntimeUpload(root)
    expect(staged.status).toBe('staged')
    if (staged.status !== 'staged') {
      return
    }
    const fileEntries = staged.entries.filter((e) => e.kind === 'file')
    expect(fileEntries.map((e) => e.relativePath).sort()).toEqual(Object.keys(files).sort())

    for (const entry of fileEntries) {
      if (entry.kind !== 'file') {
        continue
      }
      const dest = `up-${entry.relativePath.replace(/[^a-z0-9]/gi, '_')}.tmp`
      await expect(
        streamExternalFileToRuntime({
          userDataPath: '/u',
          environmentId: 'env-1',
          sourceRootPath: staged.sourcePath,
          entryRelativePath: entry.relativePath,
          expected: {
            byteLength: entry.byteLength,
            inode: entry.inode,
            deviceId: entry.deviceId,
            modifiedAtMs: entry.modifiedAtMs
          },
          worktree: 'wt-1',
          relativePath: dest
        })
      ).resolves.toEqual({ byteLength: files[entry.relativePath]!.length })
      const remote = await readFile(join(remoteDir, dest))
      expect(remote.equals(files[entry.relativePath]!)).toBe(true)
    }
  })

  it('streams a dropped single file using the identity staging recorded', async () => {
    installRealHostWrites()
    const source = join(workDir, 'single.bin')
    const body = patterned(SLICE + 1, 5)
    await writeFile(source, body)

    const staged = await stageOneSourceForRuntimeUpload(source)
    expect(staged.status).toBe('staged')
    if (staged.status !== 'staged') {
      return
    }
    const entry = staged.entries[0]!
    expect(entry.kind).toBe('file')
    if (entry.kind !== 'file') {
      return
    }

    await expect(
      streamExternalFileToRuntime({
        userDataPath: '/u',
        environmentId: 'env-1',
        sourceRootPath: staged.sourcePath,
        entryRelativePath: entry.relativePath,
        expected: entry,
        worktree: 'wt-1',
        relativePath: 'single.tmp'
      })
    ).resolves.toEqual({ byteLength: body.length })
    expect((await readFile(join(remoteDir, 'single.tmp'))).equals(body)).toBe(true)
  })
})

describe('source mutation during transfer', () => {
  it('rejects a source that grows during the transfer and never claims success', async () => {
    const source = join(workDir, 'growing.bin')
    await writeFile(source, patterned(2 * SLICE, 1))
    const args = await argsFor(source)
    callRuntimeEnvironment.mockImplementation(async (_u, _e, method) => {
      if (method === 'files.writeBase64Chunk' && chunkCalls().length === 1) {
        await appendFile(source, 'extra')
      }
      return OK
    })

    await expect(streamExternalFileToRuntime(args)).rejects.toThrow(
      "File changed during upload: 'growing.bin'"
    )
  })

  it('rejects a source truncated during the transfer instead of sending a short file', async () => {
    const source = join(workDir, 'shrinking.bin')
    await writeFile(source, patterned(3 * SLICE, 2))
    const args = await argsFor(source)
    callRuntimeEnvironment.mockImplementation(async (_u, _e, method) => {
      if (method === 'files.writeBase64Chunk' && chunkCalls().length === 1) {
        await truncate(source, SLICE)
      }
      return OK
    })

    await expect(streamExternalFileToRuntime(args)).rejects.toThrow(
      "File truncated during upload: 'shrinking.bin'"
    )
    expect(chunkCalls().length).toBeLessThan(3)
  })

  it('accepts a staged identity whose inode and device are unreported (0) when size and mtime match', async () => {
    const source = join(workDir, 'no-ino.bin')
    await writeFile(source, patterned(10, 4))
    const args = await argsFor(source)
    args.expected = { ...args.expected, inode: 0, deviceId: 0 }

    await expect(streamExternalFileToRuntime(args)).resolves.toEqual({ byteLength: 10 })
  })

  it('still refuses a wrong inode when only the device is unreported', async () => {
    const source = join(workDir, 'wrong-ino.bin')
    await writeFile(source, patterned(10, 4))
    const args = await argsFor(source)
    args.expected = { ...args.expected, inode: args.expected.inode + 1, deviceId: 0 }

    await expect(streamExternalFileToRuntime(args)).rejects.toThrow(
      "File changed since it was staged: 'wrong-ino.bin'"
    )
    expect(chunkCalls()).toHaveLength(0)
  })

  it('stops before the next slice when the signal aborts while a chunk is in flight', async () => {
    const source = join(workDir, 'abort.bin')
    await writeFile(source, patterned(3 * SLICE, 6))
    const controller = new AbortController()
    callRuntimeEnvironment.mockImplementation(async (_u, _e, method, _p, _t, _r, _env, options) => {
      if (method !== 'files.writeBase64Chunk') {
        return OK
      }
      if (chunkCalls().length === 2) {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true
          })
          controller.abort(new Error('window gone'))
        })
      }
      return OK
    })

    await expect(
      streamExternalFileToRuntime({ ...(await argsFor(source)), signal: controller.signal })
    ).rejects.toThrow('window gone')
    expect(chunkCalls()).toHaveLength(2)
  })
})

describe('formatByteCeiling bounds', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1025, '1.1 KB'],
    [25 * 1024 * 1024, '25 MB'],
    [25 * 1024 * 1024 + 1, '25.1 MB'],
    [REMOTE_IMPORT_MAX_FILE_BYTES, '2 GB'],
    [REMOTE_IMPORT_MAX_FILE_BYTES + 1, '2.1 GB'],
    [REMOTE_IMPORT_MAX_TOTAL_BYTES, '8 GB'],
    [REMOTE_IMPORT_MAX_TOTAL_BYTES + 1, '8.1 GB'],
    [1024 ** 5, '1024 TB']
  ])('%i → %s', (bytes, text) => {
    expect(formatByteCeiling(bytes)).toBe(text)
  })
})
