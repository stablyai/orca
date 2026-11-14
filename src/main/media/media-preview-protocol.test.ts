import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'

const { authorize } = vi.hoisted(() => ({
  authorize: vi.fn(async (filePath: string) => filePath)
}))
vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() }
}))
vi.mock('../ipc/filesystem/access/local-file-access-resolution', () => ({
  resolveLocalFileRequestPath: authorize
}))

vi.mock('../ipc/runtime-environments/catalog/runtime-environment-registry-root', () => ({
  readRegisteredPairingRevision: vi.fn(() => 9)
}))
vi.mock('./remote-file-preview-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteFilePreviewReader>()),
  statRemotePreviewFile: vi.fn(),
  readRemotePreviewChunk: vi.fn(),
  readRemotePreviewRange: vi.fn(),
  assertRemoteChunkReadsSupported: vi.fn()
}))
import { handleMediaPreviewRequest, readLocalFilePreview } from './media-preview-protocol'
import type * as RemoteFilePreviewReader from './remote-file-preview-reader'

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

describe('media preview protocol', () => {
  let directory: string
  const emitter = new EventEmitter()
  const event = {
    sender: {
      id: 24859,
      on: vi.fn().mockImplementation((name, callback) => emitter.on(name, callback)),
      removeListener: vi
        .fn()
        .mockImplementation((name, callback) => emitter.removeListener(name, callback))
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked authorization resolver never reads Store members.
  const store = {} as Store

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-video-protocol-'))
    authorize.mockReset().mockImplementation(async (path) => path)
  })
  afterEach(async () => {
    emitter.emit('destroyed')
    await rm(directory, { recursive: true, force: true })
  })

  it('checks the image it serves, not just the one it minted', async () => {
    const filePath = join(directory, 'swapped.png')
    await writeFile(filePath, png(4, 3))
    const result = await readLocalFilePreview(event, { filePath }, store, { documents: true })
    await writeFile(filePath, png(100_000, 100_000))
    expect((await handleMediaPreviewRequest(new Request(result?.mediaUrl ?? ''))).status).toBe(404)
  })
})
