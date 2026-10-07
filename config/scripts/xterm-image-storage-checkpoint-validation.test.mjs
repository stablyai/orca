import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const rgba = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255])
const write = (h, data) => h.core._core.writeSync(data)

describe('decoded checkpoint admission before staging allocation', () => {
  it('rejects repeated decoded image IDs before allocating any target bitmap', async () => {
    const source = terminal(),
      target = terminal()
    let checkpoint, wire
    try {
      for (const id of [7, 8]) {
        write(source, `\x1b_Ga=T,f=32,s=2,v=2,i=${id},q=2;${rgba.toString('base64')}\x1b\\`)
      }
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      const metadata = JSON.parse(JSON.stringify(checkpoint.metadata))
      const decoded = metadata.components.find((c) => c.kind === 'decoded').metadata
      expect(decoded.images).toHaveLength(2)
      decoded.images[1].id = decoded.images[0].id
      const resources = new Map(
        metadata.resources.map((r) => [r.id, checkpoint.copyResource(r.id, r.byteLength)])
      )
      wire = new checkpoint.constructor(metadata, resources)
      write(target, source.serializer.serialize())
      const allocate = vi.spyOn(target.backend, 'fromRgba')
      await expect(target.addon.restoreCheckpoint(wire)).rejects.toThrow()
      expect(allocate).not.toHaveBeenCalled()
      expect(target.storage._images.size).toBe(0)
    } finally {
      vi.restoreAllMocks()
      wire?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each([
    [
      'repeated ID',
      (m) => {
        m.images[1].id = m.images[0].id
      }
    ],
    [
      'reused pixel resource',
      (m) => {
        m.images[1].resourceId = m.images[0].resourceId
      }
    ],
    [
      'old ID counter',
      (m) => {
        m.lastId = 0
      }
    ],
    [
      'invalid later dimensions',
      (m) => {
        m.images[1].width = 0
      }
    ],
    [
      'invalid cell metrics',
      (m) => {
        m.images[0].origCellSize.width = 0
      }
    ],
    [
      'invalid layer',
      (m) => {
        m.images[0].layer = 'unknown'
      }
    ],
    [
      'invalid buffer',
      (m) => {
        m.images[0].bufferType = 'unknown'
      }
    ],
    [
      'invalid tile count',
      (m) => {
        m.images[0].tileCount = -1
      }
    ],
    [
      'invalid protocol ID',
      (m) => {
        m.images[0].kittyId = 2 ** 32
      }
    ],
    [
      'invalid marker',
      (m) => {
        m.images[0].markerLine = m.normalLength
      }
    ],
    [
      'wrong resource length',
      (m) => {
        m.resources[0].byteLength -= 1
      }
    ],
    [
      'unaccounted bytes',
      (m) => {
        m.byteLength -= 1
      }
    ]
  ])(
    'rejects %s in the decoded component without touching existing pixels',
    async (_name, change) => {
      const source = terminal(),
        target = terminal()
      let checkpoint, wire
      try {
        for (const id of [7, 8]) {
          write(source, `\x1b_Ga=T,f=32,s=2,v=2,i=${id},q=2;${rgba.toString('base64')}\x1b\\`)
        }
        write(target, `\x1b_Ga=T,f=32,s=2,v=2,i=20,q=2;${rgba.toString('base64')}\x1b\\`)
        const old = target.storage.getImageSpec(1)
        checkpoint = source.storage.captureCheckpoint(1024)
        const metadata = JSON.parse(JSON.stringify(checkpoint.metadata))
        change(metadata)
        wire = new checkpoint.constructor(
          metadata,
          new Map(
            checkpoint.metadata.resources.map((r) => [
              r.id,
              checkpoint.copyResource(r.id, r.byteLength)
            ])
          )
        )
        const allocate = vi.spyOn(target.backend, 'fromRgba')
        await expect(target.storage.restoreCheckpoint(wire)).rejects.toThrow()
        expect(allocate).not.toHaveBeenCalled()
        expect(target.storage.getImageSpec(1)).toBe(old)
        expect(old.orig.data.byteLength).toBe(16)
      } finally {
        vi.restoreAllMocks()
        wire?.dispose()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each([
    [
      'missing image',
      (view) => {
        view.setFloat64(12, 999, true)
      }
    ],
    [
      'outside source tiles',
      (view) => {
        view.setFloat64(20, 999, true)
      }
    ],
    [
      'fractional tile',
      (view) => {
        view.setFloat64(20, 0.5, true)
      }
    ],
    [
      'overlapping runs',
      (view) => {
        view.setUint32(32 + 8, 0, true)
      }
    ]
  ])('rejects a binary tile table with %s before allocating pixels', async (_name, change) => {
    const source = terminal(),
      target = terminal()
    let checkpoint, wire
    try {
      for (const id of [7, 8]) {
        write(source, `\x1b_Ga=T,f=32,s=2,v=2,i=${id},q=2;${rgba.toString('base64')}\x1b\\`)
      }
      checkpoint = source.storage.captureCheckpoint(1024)
      const metadata = JSON.parse(JSON.stringify(checkpoint.metadata))
      const resources = new Map(
        metadata.resources.map((r) => [r.id, checkpoint.copyResource(r.id, r.byteLength)])
      )
      const bytes = resources.get(metadata.tilesResourceId)
      change(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      wire = new checkpoint.constructor(metadata, resources)
      const allocate = vi.spyOn(target.backend, 'fromRgba')
      await expect(target.storage.restoreCheckpoint(wire)).rejects.toThrow()
      expect(allocate).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      wire?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('checks every image against the target pixel limit before allocating the first one', async () => {
    const source = terminal(),
      target = terminal(false, { pixelLimit: 8 })
    let checkpoint
    try {
      for (const [size, id] of [
        [2, 7],
        [3, 8]
      ]) {
        const bytes = Buffer.alloc(size * size * 4, 255)
        write(
          source,
          `\x1b_Ga=T,f=32,s=${size},v=${size},i=${id},q=2;${bytes.toString('base64')}\x1b\\`
        )
      }
      checkpoint = source.storage.captureCheckpoint(1024)
      const allocate = vi.spyOn(target.backend, 'fromRgba')
      await expect(target.storage.restoreCheckpoint(checkpoint)).rejects.toThrow(/pixel limit/)
      expect(allocate).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('owns metadata and tile bytes before resource reads can alter caller state', async () => {
    const source = terminal(),
      target = terminal()
    let checkpoint, wire
    try {
      for (const id of [7, 8]) {
        write(source, `\x1b_Ga=T,f=32,s=2,v=2,i=${id},q=2;${rgba.toString('base64')}\x1b\\`)
      }
      checkpoint = source.storage.captureCheckpoint(1024)
      const metadata = JSON.parse(JSON.stringify(checkpoint.metadata))
      const resources = new Map(
        metadata.resources.map((r) => [r.id, checkpoint.copyResource(r.id, r.byteLength)])
      )
      wire = new checkpoint.constructor(metadata, resources)
      const read = wire.readResource.bind(wire)
      wire.readResource = (...args) => {
        if (args[0] === metadata.images[0].resourceId) {
          metadata.images[1].id = metadata.images[0].id
          resources.get(metadata.tilesResourceId).fill(0)
        }
        return read(...args)
      }
      await target.storage.restoreCheckpoint(wire)
      expect([...target.storage._images.keys()]).toEqual([1, 2])
      const line = target.core._core.buffers.normal.lines.get(0)
      expect(line._extendedAttrs[0].imageId).toBe(1)
      expect(line._extendedAttrs[1].imageId).toBe(2)
    } finally {
      wire?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('does not revive tile attributes hidden by a text overwrite after image eviction', async () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, `\x1b_Ga=T,f=32,s=2,v=2,i=7,q=2;${rgba.toString('base64')}\x1b\\`)
      source.storage.deleteImage(1)
      write(source, '\x1b[Hreplacement')
      const before = source.core._core.buffers.normal.lines.get(0)._extendedAttrs[0]
      expect(before.imageId).toBe(1)
      expect(source.core._core.buffers.normal.lines.get(0).getBg(0) & 0x10000000).toBe(0)
      checkpoint = source.storage.captureCheckpoint(1024)
      expect(checkpoint.getResourceByteLength(checkpoint.metadata.tilesResourceId)).toBe(0)
      await target.storage.restoreCheckpoint(checkpoint)
      expect(target.storage._images.size).toBe(0)
      expect(source.core._core.buffers.normal.lines.get(0)._extendedAttrs[0]).toBe(before)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each([Infinity, -0])('preserves unusual stored z-index %s through JSON', async (zIndex) => {
    const source = terminal(),
      target = terminal()
    let checkpoint, wire
    try {
      source.storage.addUnplacedImage(source.backend.fromRgba(new Uint8Array(rgba), 2, 2), {
        layer: 'top',
        zIndex
      })
      checkpoint = source.storage.captureCheckpoint(1024)
      const metadata = JSON.parse(JSON.stringify(checkpoint.metadata))
      wire = new checkpoint.constructor(
        metadata,
        new Map(metadata.resources.map((r) => [r.id, checkpoint.copyResource(r.id, r.byteLength)]))
      )
      source.core.dispose()
      await target.storage.restoreCheckpoint(wire)
      expect(Object.is(target.storage.getImageSpec(1).zIndex, zIndex)).toBe(true)
    } finally {
      wire?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['reset', 'dispose', 'resize', 'lease', 'pixel limit'])(
    'rejects %s during a pixel read before allocating a bitmap',
    async (action) => {
      const source = terminal(),
        target = terminal()
      let checkpoint, wire
      try {
        write(source, `\x1b_Ga=T,f=32,s=2,v=2,i=7,q=2;${rgba.toString('base64')}\x1b\\`)
        checkpoint = source.storage.captureCheckpoint(1024)
        const metadata = JSON.parse(JSON.stringify(checkpoint.metadata))
        wire = new checkpoint.constructor(
          metadata,
          new Map(
            metadata.resources.map((r) => [r.id, checkpoint.copyResource(r.id, r.byteLength)])
          )
        )
        const read = wire.readResource.bind(wire)
        wire.readResource = (...args) => {
          const bytes = read(...args)
          if (args[0] === metadata.images[0].resourceId) {
            if (action === 'reset') {
              target.addon.reset()
            } else if (action === 'dispose') {
              target.core.dispose()
            } else if (action === 'resize') {
              target.core.resize(21, 10)
            } else if (action === 'lease') {
              wire.dispose()
            } else {
              target.addon._opts.pixelLimit = 1
            }
          }
          return bytes
        }
        const allocate = vi.spyOn(target.backend, 'fromRgba')
        await expect(target.storage.restoreCheckpoint(wire)).rejects.toThrow()
        expect(allocate).not.toHaveBeenCalled()
      } finally {
        vi.restoreAllMocks()
        wire?.dispose()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('rejects a nonboolean buffer word even when the alternate target row exists', async () => {
    const source = terminal(),
      target = terminal()
    let checkpoint, wire
    try {
      write(source, `\x1b_Ga=T,f=32,s=2,v=2,i=7,q=2;${rgba.toString('base64')}\x1b\\`)
      write(source, `\x1b[?1049h\x1b_Ga=T,f=32,s=2,v=2,i=8,q=2;${rgba.toString('base64')}\x1b\\`)
      checkpoint = source.storage.captureCheckpoint(1024)
      const metadata = JSON.parse(JSON.stringify(checkpoint.metadata))
      const resources = new Map(
        metadata.resources.map((r) => [r.id, checkpoint.copyResource(r.id, r.byteLength)])
      )
      const bytes = resources.get(metadata.tilesResourceId)
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, 2, true)
      wire = new checkpoint.constructor(metadata, resources)
      write(target, source.serializer.serialize())
      const allocate = vi.spyOn(target.backend, 'fromRgba')
      await expect(target.storage.restoreCheckpoint(wire)).rejects.toThrow()
      expect(allocate).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      wire?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['narrow', 'expand', 'scroll', 'overwrite'])(
    'restores live placements after %s without retaining dead references',
    async (action) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        const bytes = Buffer.alloc(64 * 12 * 4, 255)
        write(source, `\x1b_Ga=T,f=32,s=64,v=12,i=7,q=2;${bytes.toString('base64')}\x1b\\`)
        if (action === 'narrow') {
          source.core.resize(10, 10)
        } else if (action === 'expand') {
          source.core.resize(40, 10)
        } else if (action === 'scroll') {
          write(source, 'next\r\n'.repeat(40))
        } else {
          write(source, '\x1b[H\x1b[2Kreplacement')
        }
        const expected = [...source.storage._images].map(([id, value]) => [
          id,
          value.orig.data.slice()
        ])
        checkpoint = source.storage.captureCheckpoint(1024 * 1024)
        target.core.resize(source.core.cols, source.core.rows)
        write(target, source.serializer.serialize())
        await target.storage.restoreCheckpoint(checkpoint)
        expect([...target.storage._images].map(([id, value]) => [id, value.orig.data])).toEqual(
          expected
        )
        checkpoint.forEachTileRun((run) => {
          const line = target.core._core.buffers.normal.lines.get(run.row)
          for (let col = 0; col < run.count; col++) {
            expect(line._extendedAttrs[run.col + col].imageId).toBe(run.imageId)
            expect(line._extendedAttrs[run.col + col].tileId).toBe(run.tileId + col)
          }
        })
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )
})
