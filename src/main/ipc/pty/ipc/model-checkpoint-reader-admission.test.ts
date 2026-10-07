import { expect, it, vi } from 'vitest'
import { imageCheckpointMetadataBytes } from '@xterm/addon-image/src/ImageCheckpointMetadata'
import { readTerminalModelCheckpoint } from '../../../../shared/terminal-model-checkpoint-reader'
import { parseTerminalModelCheckpointMetadata } from '../../../../shared/terminal-model-checkpoint-schema'
import { PTY_ID } from '../../../runtime/headless-hydration-ownership-test-fixture'
import { incarnationId, install } from './model-checkpoint-test-fixture'
import { transport } from './model-checkpoint-reader-test-fixture'

it.each([
  { ptyId: 'other-terminal' },
  { incarnationId: 'other-incarnation' },
  { sourceSeq: -1 },
  { sourceSeq: Number.MAX_SAFE_INTEGER + 1 },
  { metadataByteLength: 8 * 1024 * 1024 + 1 },
  { byteLength: 128 * 1024 * 1024 + 1 }
])('rejects an invalid descriptor before allocating its metadata %j', async (change) => {
  install()
  const original = transport.captureModelCheckpoint
  const read = vi.spyOn(transport, 'readModelCheckpoint')
  const release = vi.spyOn(transport, 'releaseModelCheckpoint')
  vi.spyOn(transport, 'captureModelCheckpoint').mockImplementation(async (id, incarnation) => {
    const descriptor = await original(id, incarnation)
    if (!descriptor) {
      throw new Error('Expected descriptor')
    }
    return { ...descriptor, ...change }
  })
  await expect(
    readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => true)
  ).rejects.toThrow()
  expect(read).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
})

it('does not contact the host for an already stale request', async () => {
  const capture = vi.spyOn(transport, 'captureModelCheckpoint')
  await expect(
    readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => false)
  ).rejects.toThrow('stale')
  expect(capture).not.toHaveBeenCalled()
})

it('returns a declined capture without requesting or releasing nonexistent resources', async () => {
  install()
  vi.spyOn(transport, 'captureModelCheckpoint').mockResolvedValueOnce(null)
  const read = vi.spyOn(transport, 'readModelCheckpoint')
  const release = vi.spyOn(transport, 'releaseModelCheckpoint')
  await expect(
    readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => true)
  ).resolves.toBeNull()
  expect(read).not.toHaveBeenCalled()
  expect(release).not.toHaveBeenCalled()
})

it.each(['short', 'long', 'invalid UTF-8', 'invalid JSON'])(
  'rejects %s metadata delivery and releases the host lease',
  async (kind) => {
    install()
    const original = transport.readModelCheckpoint
    const release = vi.spyOn(transport, 'releaseModelCheckpoint')
    vi.spyOn(transport, 'readModelCheckpoint').mockImplementation(async (id, window) => {
      const bytes = await original(id, window)
      if (window.resourceId !== null) {
        return bytes
      }
      if (kind === 'short') {
        return bytes.subarray(1)
      }
      if (kind === 'long') {
        return new Uint8Array(bytes.length + 1)
      }
      bytes.fill(kind === 'invalid UTF-8' ? 0xff : 0x20)
      return bytes
    })
    await expect(
      readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => true)
    ).rejects.toThrow()
    expect(release).toHaveBeenCalledOnce()
  }
)

it.each(['grid', 'colors', 'sequence', 'image replay', 'resource count', 'resource budget'])(
  'declines malformed %s metadata before requesting binary resources',
  async (kind) => {
    install()
    const originalCapture = transport.captureModelCheckpoint
    const originalRead = transport.readModelCheckpoint
    let wire = new Uint8Array()
    vi.spyOn(transport, 'captureModelCheckpoint').mockImplementation(async (id, incarnation) => {
      const descriptor = await originalCapture(id, incarnation)
      if (!descriptor) {
        throw new Error('Expected descriptor')
      }
      const metadata = await originalRead(id, {
        leaseId: descriptor.leaseId,
        resourceId: null,
        offset: 0,
        length: descriptor.metadataByteLength
      })
      const value: unknown = JSON.parse(new TextDecoder().decode(metadata))
      const header = structuredClone(parseTerminalModelCheckpointMetadata(value))
      if (kind === 'grid') {
        header.configuration.cols = 1001
      }
      if (kind === 'colors' && header.configuration.images) {
        header.configuration.images.colors.background.rgba = -1
      }
      if (kind === 'sequence') {
        header.snapshot.outputSequence = descriptor.sourceSeq + 1
      }
      if (kind === 'image replay') {
        header.snapshot.snapshotAnsi += '\x1b_Ga=t;payload\x1b\\'
      }
      if (kind === 'resource count') {
        const first = header.graphics.resources[0]
        if (!first) {
          throw new Error('Expected real resource')
        }
        header.graphics = { ...header.graphics, resources: [...header.graphics.resources, first] }
      }
      if (kind === 'resource budget') {
        header.graphics = {
          ...header.graphics,
          resourceByteLength: header.graphics.resourceByteLength + 1
        }
      }
      header.metadataByteLength = imageCheckpointMetadataBytes(header)
      header.byteLength = header.graphics.resourceByteLength + header.metadataByteLength
      wire = new TextEncoder().encode(JSON.stringify(header))
      return { ...descriptor, metadataByteLength: wire.length, byteLength: header.byteLength }
    })
    const read = vi
      .spyOn(transport, 'readModelCheckpoint')
      .mockImplementation(async (id, window) => {
        return window.resourceId === null
          ? wire.slice(window.offset, window.offset + window.length)
          : originalRead(id, window)
      })
    const release = vi.spyOn(transport, 'releaseModelCheckpoint')
    await expect(
      readTerminalModelCheckpoint(transport, PTY_ID, incarnationId, () => true)
    ).rejects.toThrow()
    expect(read.mock.calls.every(([, window]) => window.resourceId === null)).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  }
)
