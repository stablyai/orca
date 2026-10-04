import * as filesystem from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { reasonixHistoryAccess } from './session-scanner-reasonix-access'
import { reasonixLocalHistoryReader } from './session-scanner-reasonix-parser'
import { readReasonixDecodedHistorySnapshot } from './reasonix-decoded-history-snapshot'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>()
  return { ...actual, open: vi.fn(actual.open) }
})

const id = '985b66b859ffae5cd8d17ef63ec3d33c'
let root = ''
let path = ''
beforeEach(async () => {
  root = await filesystem.mkdtemp(join(tmpdir(), 'rx-local-read-'))
  path = join(root, 'projects/-workspace/sessions-v4', id, 'events.frames')
  await filesystem.mkdir(dirname(path), { recursive: true })
  for (const [source, destination] of [
    ['frames', 'events.frames'],
    ['manifest.json', 'manifest.json']
  ]) {
    await filesystem.copyFile(
      join(__dirname, '__fixtures__', `reasonix-1-39-7-native-auth-rejection.${source}`),
      join(dirname(path), destination)
    )
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await filesystem.rm(root, { recursive: true, force: true })
})

async function drainTranscript(bytes: AsyncIterable<Buffer>): Promise<void> {
  for await (const _chunk of bytes) {
    // Consume the production byte stream to exercise its open and close boundary.
  }
}

it.skipIf(process.platform === 'win32')(
  'refuses a metadata symlink installed after the local ownership stat',
  async () => {
    const manifest = join(dirname(path), 'manifest.json')
    const saved = join(root, 'saved-manifest.json')
    const { provider, host } = reasonixLocalHistoryReader(path, process.platform)
    const stat = provider.stat
    vi.spyOn(provider, 'stat').mockImplementation(async (file) => {
      const observed = await stat(file)
      if (file === manifest) {
        await filesystem.rename(file, saved)
        await filesystem.symlink(saved, file)
      }
      return observed
    })
    await expect(reasonixHistoryAccess(provider, host, path)).rejects.toThrow('regular file')
    await expect(drainTranscript(openTranscriptReadStream(manifest, {}, 'exact'))).resolves.toBe(
      undefined
    )
  }
)

it.skipIf(process.platform === 'win32')(
  'refuses a final transcript symlink on the local production byte reader',
  async () => {
    const saved = join(root, 'saved.frames')
    await filesystem.rename(path, saved)
    await filesystem.symlink(saved, path)
    const { provider } = reasonixLocalHistoryReader(path, process.platform)
    const read = provider.readTranscriptBytes
    if (!read) {
      throw new Error('Missing local byte reader')
    }
    await expect(drainTranscript(read(path))).rejects.toThrow('regular file')
    await expect(drainTranscript(openTranscriptReadStream(path, {}, 'exact'))).resolves.toBe(
      undefined
    )
  }
)

it.skipIf(process.platform === 'win32')(
  'rejects a FIFO substituted between the guarded lstat and actual open without blocking',
  async () => {
    const { open } = await vi.importActual<typeof filesystem>('node:fs/promises')
    vi.mocked(filesystem.open).mockImplementationOnce(async (...args) => {
      await filesystem.rename(path, join(root, 'saved.frames'))
      const result = await runProcess({ program: 'mkfifo', args: [path] })
      expect(result.code).toBe(0)
      return open(...args)
    })
    const { provider } = reasonixLocalHistoryReader(path, process.platform)
    const read = provider.readTranscriptBytes
    if (!read) {
      throw new Error('Missing local byte reader')
    }
    await expect(drainTranscript(read(path))).rejects.toThrow('regular file')
  }
)

it.skipIf(process.platform === 'win32')(
  'refuses native FIFO and socket metadata through the decoded product log',
  async () => {
    const manifest = join(dirname(path), 'manifest.json')
    await filesystem.rm(manifest)
    const result = await runProcess({ program: 'mkfifo', args: [manifest] })
    expect(result.code).toBe(0)
    await expect(readReasonixDecodedHistorySnapshot(path)).rejects.toThrow('regular file')
    await filesystem.rm(manifest)
    const socket = createServer()
    try {
      const socketPath = join(root, 's')
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.listen(socketPath, resolve)
      })
      await filesystem.rename(socketPath, manifest)
      await expect(readReasonixDecodedHistorySnapshot(path)).rejects.toThrow('regular file')
    } finally {
      if (socket.listening) {
        await new Promise<void>((resolve, reject) => {
          socket.close((error) => (error ? reject(error) : resolve()))
        })
      }
    }
  }
)

it('does not open the local transcript when the caller was already aborted', async () => {
  const open = vi.mocked(filesystem.open).mockClear()
  const controller = new AbortController()
  controller.abort()
  const { provider } = reasonixLocalHistoryReader(path, process.platform, controller.signal)
  const read = provider.readTranscriptBytes
  if (!read) {
    throw new Error('Missing local byte reader')
  }
  await expect(drainTranscript(read(path))).rejects.toMatchObject({ name: 'AbortError' })
  expect(open).not.toHaveBeenCalled()
})
