import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'
import fixtures from '../../src/shared/__fixtures__/terminal-raster-red.json'

const write = (h, data) => h.core._core.writeSync(data)
const rgba = Buffer.from([255, 100, 0, 255, 255, 100, 0, 255, 255, 100, 0, 255, 255, 100, 0, 255])
const kitty = (control, bytes = rgba) => `\x1b_G${control};${bytes.toString('base64')}\x1b\\`
const small = kitty('a=T,f=32,s=2,v=2,i=7,q=2')
const iip = `\x1b]1337;File=inline=1;width=8px;height=8px:${fixtures.png}\x07`
const sixel = '\x1bPq"1;1;12;18#1;2;100;0;0#1!12~-!8~-!4~\x1b\\'

function pixels(h) {
  return [...h.storage._images].map(([id, value]) => ({
    id,
    width: value.orig.width,
    height: value.orig.height,
    data: value.orig.data.slice()
  }))
}
function transported(checkpoint, change = (m) => m) {
  const resources = new Map(
    checkpoint.metadata.resources.map((r) => [r.id, checkpoint.copyResource(r.id, r.byteLength)])
  )
  return new checkpoint.constructor(
    change(JSON.parse(JSON.stringify(checkpoint.metadata)), resources),
    resources
  )
}

async function reconstruct(checkpoint, ansi, options = {}) {
  const target = terminal(false, options)
  try {
    write(target, ansi)
    await target.addon.restoreCheckpoint(checkpoint)
    return target
  } catch (error) {
    target.core.dispose()
    throw error
  }
}

describe('whole image addon checkpoint lease', () => {
  it('combines completed protocols, retained Kitty sources and palette in one owned lease', async () => {
    const source = terminal()
    let checkpoint, wire, target
    try {
      write(source, `${small + iip + sixel + kitty('a=t,f=32,s=2,v=2,i=19,q=2')}AFTER`)
      const expected = pixels(source),
        ansi = source.serializer.serialize()
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      expect(checkpoint.metadata.components.map((c) => c.kind)).toEqual([
        'decoded',
        'kitty-sources',
        'kitty-pending',
        'iip-pending',
        'sixel-state'
      ])
      wire = transported(checkpoint)
      source.core.dispose()
      checkpoint.dispose()
      target = await reconstruct(wire, ansi)
      expect(pixels(target)).toEqual(expected)
      write(target, kitty('a=p,i=19,q=2', Buffer.alloc(0)))
      expect(target.storage._images.size).toBe(4)
      write(target, '\x1bPq"1;1;1;6#1~\x1b\\')
      expect(Array.from(pixels(target).at(-1).data.slice(0, 4))).toEqual([255, 0, 0, 255])
    } finally {
      wire?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target?.core.dispose()
    }
  })

  it.each([
    ['kitty', '\x1b_Ga=T,f=32,s=2,v=2,i=30,q=2;', `${rgba.toString('base64')}\x1b\\`],
    ['iip', '\x1b]1337;File=inline=1;width=8px;height=8px:', `${fixtures.png}\x07`],
    ['sixel', '\x1bPq"1;1;12;18#1;2;100;0;0#1!12~-!8', '~-!4~\x1b\\']
  ])(
    'restores completed images and active %s together, then accepts only new bytes',
    async (kind, prefix, tail) => {
      const source = terminal()
      let checkpoint, target
      try {
        write(source, small + prefix + tail.slice(0, 2))
        const ansi = source.serializer.serialize()
        checkpoint = source.addon.captureCheckpoint(1024 * 1024)
        const names = checkpoint.metadata.components.map((c) => c.kind)
        expect(names).toContain(`${kind}-active`)
        if (kind === 'iip') {
          expect(names).not.toContain('iip-pending')
        }
        if (kind === 'sixel') {
          expect(names).not.toContain('sixel-state')
        }
        write(source, `${tail.slice(2)}AFTER`)
        const expected = pixels(source)
        source.core.dispose()
        target = await reconstruct(checkpoint, ansi)
        write(target, `${tail.slice(2)}AFTER`)
        expect(pixels(target)).toEqual(expected)
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target?.core.dispose()
      }
    }
  )

  it('preserves implicit pending Kitty continuation and its active decoder alias', async () => {
    const source = terminal()
    let checkpoint, target
    try {
      const b64 = rgba.toString('base64')
      write(source, `\x1b_Ga=T,f=32,s=2,v=2,i=30,m=1,q=2;${b64.slice(0, 8)}\x1b\\`)
      write(source, `\x1b_Gm=0,q=2;${b64.slice(8, 11)}`)
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      const ansi = source.serializer.serialize()
      write(source, `${b64.slice(11)}\x1b\\`)
      const expected = pixels(source)
      source.core.dispose()
      target = await reconstruct(checkpoint, ansi)
      write(target, `${b64.slice(11)}\x1b\\`)
      expect(pixels(target)).toEqual(expected)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target?.core.dispose()
    }
  })

  it('preserves healthy IIP multipart ownership while its next header is partial', async () => {
    const source = terminal()
    let checkpoint, target
    try {
      const b64 = fixtures.png
      write(source, `\x1b]1337;MultipartFile=inline=1;width=8px;height=8px;size=1024\x07`)
      write(source, `\x1b]1337;FilePart=${b64.slice(0, 10)}\x07\x1b]1337;FilePar`)
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      const ansi = source.serializer.serialize()
      const tail = `t=${b64.slice(10)}\x07\x1b]1337;FileEnd\x07AFTER`
      write(source, tail)
      const expected = pixels(source)
      source.core.dispose()
      target = await reconstruct(checkpoint, ansi)
      write(target, tail)
      expect(pixels(target)).toEqual(expected)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target?.core.dispose()
    }
  })

  it.each(['kitty', 'iip'])(
    'preserves unusual numeric pending %s fields through JSON',
    async (kind) => {
      const source = terminal()
      let checkpoint, wire, target
      try {
        if (kind === 'kitty') {
          write(source, kitty('a=t,f=32,s=2,v=2,i=30,m=1,q=2,x=bad,y=-0', rgba.subarray(0, 6)))
          const command = source.addon._handlers.get('kitty')._pendingTransmissions.get(30).cmd
          expect(Number.isNaN(command.x)).toBe(true)
          expect(Object.is(command.y, -0)).toBe(true)
        } else {
          write(
            source,
            `\x1b]1337;MultipartFile=inline=1;width=8px;height=8px;preserveAspectRatio=${'9'.repeat(400)}\x07`
          )
          expect(source.addon._handlers.get('iip')._header.preserveAspectRatio).toBe(Infinity)
        }
        checkpoint = source.addon.captureCheckpoint(1024 * 1024)
        wire = transported(checkpoint)
        const ansi = source.serializer.serialize()
        source.core.dispose()
        target = await reconstruct(wire, ansi)
        if (kind === 'kitty') {
          const command = target.addon._handlers.get('kitty')._pendingTransmissions.get(30).cmd
          expect(Number.isNaN(command.x)).toBe(true)
          expect(Object.is(command.y, -0)).toBe(true)
          write(target, kitty('m=0,q=2', rgba.subarray(6)))
          expect(target.kittyStorage.getImage(30).data).toEqual(new Uint8Array(rgba))
        } else {
          const header = target.addon._handlers.get('iip')._header
          expect(header.preserveAspectRatio).toBe(Infinity)
          write(target, `\x1b]1337;FilePart=${fixtures.png}\x07\x1b]1337;FileEnd\x07`)
          expect(target.storage._images.size).toBe(1)
        }
      } finally {
        wire?.dispose()
        checkpoint?.dispose()
        source.core.dispose()
        target?.core.dispose()
      }
    }
  )

  it('owns both text-buffer placements when the alternate screen is active', async () => {
    const source = terminal()
    let checkpoint, target
    try {
      write(source, `${small}\x1b[?1049h${iip}`)
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      const expected = pixels(source),
        ansi = source.serializer.serialize()
      target = await reconstruct(checkpoint, ansi)
      expect(pixels(target)).toEqual(expected)
      expect(target.core.buffer.active.type).toBe('alternate')
      write(target, '\x1b[?1049l')
      expect(target.storage._images.size).toBe(1)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target?.core.dispose()
    }
  })

  it('restores normal images after leaving the discarded alternate screen', async () => {
    const source = terminal()
    let checkpoint, target
    try {
      write(source, `${small}\x1b[?1049h${iip}\x1b[?1049lNORMAL`)
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      const expected = pixels(source),
        ansi = source.serializer.serialize()
      source.core.dispose()
      target = await reconstruct(checkpoint, ansi)
      expect(target.core.buffer.active.type).toBe('normal')
      expect(pixels(target)).toEqual(expected)
      expect(
        Array.from({ length: target.core.rows }, (_, row) =>
          target.core.buffer.active.getLine(row).translateToString(true)
        ).join('\n')
      ).toContain('NORMAL')
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target?.core.dispose()
    }
  })

  it('checks the combined resource and metadata budget and leaves the producer healthy', () => {
    const source = terminal()
    let checkpoint
    try {
      write(source, small + sixel)
      const before = pixels(source)
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      const resources = checkpoint.metadata.resources.reduce((sum, r) => sum + r.byteLength, 0)
      expect(checkpoint.metadata.resourceByteLength).toBe(resources)
      expect(checkpoint.metadata.byteLength).toBeGreaterThan(resources)
      expect(() => source.addon.captureCheckpoint(checkpoint.metadata.byteLength - 1)).toThrow(
        /budget/i
      )
      expect(pixels(source)).toEqual(before)
      write(source, kitty('a=T,f=32,s=2,v=2,i=8,q=2'))
      expect(source.storage._images.size).toBe(3)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
    }
  })

  it('expires all borrowed resource views together without exposing mutable lease bytes', () => {
    const source = terminal()
    let checkpoint, part
    try {
      write(source, small)
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      part = checkpoint.openComponent(checkpoint.metadata.components[0])
      const descriptor = part.checkpoint.metadata.resources[0]
      const copied = part.checkpoint.readResource(descriptor.id, 0, descriptor.byteLength)
      copied.fill(0)
      expect(part.checkpoint.copyResource(descriptor.id, descriptor.byteLength)).not.toEqual(copied)
      expect(() => part.checkpoint.takeResources()).toThrow(/borrowed/i)
      checkpoint.dispose()
      expect(part.checkpoint.isDisposed).toBe(true)
      expect(part.checkpoint._resources.size).toBe(0)
      expect(() => part.checkpoint.copyResource(descriptor.id, descriptor.byteLength)).toThrow(
        /disposed/i
      )
      expect(() => part.checkpoint.forEachTileRun(() => {})).toThrow(/disposed/i)
    } finally {
      part?.checkpoint.dispose()
      checkpoint?.dispose()
      source.core.dispose()
    }
  })

  it('rejects sparse oversized metadata before making a clone', async () => {
    const source = terminal(),
      target = terminal()
    let checkpoint, wire
    try {
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      wire = transported(checkpoint)
      wire.metadata.extra = []
      wire.metadata.extra.length = 10000
      const clone = vi.spyOn(globalThis, 'structuredClone')
      await expect(target.addon.restoreCheckpoint(wire)).rejects.toThrow()
      expect(clone).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      wire?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('owns the entire metadata graph before reading any resource', async () => {
    const source = terminal()
    let checkpoint, wire, target
    try {
      write(source, small + kitty('a=t,f=32,s=2,v=2,i=30,m=1,q=2', rgba.subarray(0, 6)))
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      wire = transported(checkpoint)
      const read = wire.readResource.bind(wire)
      wire.readResource = (...args) => {
        const pending = wire.metadata.components.find((c) => c.kind === 'kitty-pending')
        pending.metadata.pending[0].command.width = '4000'
        return read(...args)
      }
      target = await reconstruct(wire, source.serializer.serialize())
      const pending = target.addon._handlers.get('kitty')._pendingTransmissions.get(30)
      expect(pending.cmd.width).toBe(2)
      write(target, kitty('m=0,q=2', rgba.subarray(6)))
      expect(target.kittyStorage.getImage(30).data).toEqual(new Uint8Array(rgba))
    } finally {
      wire?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target?.core.dispose()
    }
  })

  it.each(['lease', 'reset', 'dispose'])(
    'rejects %s invalidation while decoding the replacement',
    async (action) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        write(source, small)
        checkpoint = source.addon.captureCheckpoint(1024 * 1024)
        write(target, source.serializer.serialize())
        const fromRgba = target.backend.fromRgba.bind(target.backend)
        vi.spyOn(target.backend, 'fromRgba').mockImplementation((...args) => {
          const pixels = fromRgba(...args)
          if (action === 'lease') {
            checkpoint.dispose()
          } else if (action === 'reset') {
            target.addon.reset()
          } else {
            target.core.dispose()
          }
          return pixels
        })
        await expect(target.addon.restoreCheckpoint(checkpoint)).rejects.toThrow()
        expect(target.storage._images.size).toBe(0)
      } finally {
        vi.restoreAllMocks()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each([
    [
      'component order',
      (m) => ({ ...m, components: [m.components[1], m.components[0], ...m.components.slice(2)] })
    ],
    ['version', (m) => ({ ...m, version: 2 })],
    ['duplicate component', (m) => ({ ...m, components: [...m.components, m.components[0]] })],
    ['missing component', (m) => ({ ...m, components: m.components.slice(1) })],
    [
      'missing resource',
      (m, r) => {
        r.clear()
        return m
      }
    ],
    ['wrong byte length', (m) => ({ ...m, byteLength: 0 })]
  ])('rejects %s before decoding any target pixels', async (_name, change) => {
    const source = terminal(),
      target = terminal()
    let checkpoint, altered
    try {
      write(source, small)
      checkpoint = source.addon.captureCheckpoint(1024 * 1024)
      altered = transported(checkpoint, change)
      write(target, source.serializer.serialize())
      const allocate = vi.spyOn(target.backend, 'fromRgba')
      await expect(target.addon.restoreCheckpoint(altered)).rejects.toThrow()
      expect(allocate).not.toHaveBeenCalled()
      expect(target.storage._images.size).toBe(0)
    } finally {
      vi.restoreAllMocks()
      altered?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })
})
