import { placeholderCells } from './xterm-kitty-placeholder-test-terminal.mjs'
import { imageCheckpointMetadataBytes } from '@xterm/addon-image/src/ImageCheckpointMetadata'
import { HeadlessModelCheckpoint } from '../../src/main/daemon/headless-model-checkpoint'
import { NodeTerminalRasterBackend } from '../../src/shared/node-terminal-raster-backend'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../../src/main/daemon/headless-emulator'

const options = {
  cols: 20,
  rows: 10,
  scrollback: 20,
  images: {
    cellSize: { width: 2, height: 2 },
    colors: {
      foreground: { rgba: 0xffffffff },
      background: { rgba: 0x000000ff },
      ansi: []
    }
  }
}
class Probe extends HeadlessEmulator {
  get core() {
    return this.terminal
  }
  get addon() {
    return this.imageAddon
  }
}
const png = JSON.parse(
  readFileSync(
    new URL('../../src/shared/__fixtures__/terminal-raster-red.json', import.meta.url),
    'utf8'
  )
).png
const kitty = (id, payload = Buffer.alloc(16, 255).toString('base64')) =>
  `\x1b_Ga=T,f=32,s=2,v=2,i=${id},q=2;${payload}\x1b\\`
const pixels = (h) =>
  [...h.addon._storage._images].map(([id, value]) => [id, Array.from(value.orig.data)])

describe('complete headless model checkpoint', () => {
  it.each(['normal', 'alternate', 'scrollback'])(
    'restores text and all image state in %s',
    async (mode) => {
      const source = new Probe(options)
      let checkpoint, restored
      try {
        await source.write(`normal\r\n${kitty(7)}`)
        if (mode === 'alternate') {
          await source.write(`\x1b[?1049halt\r\n${kitty(8)}`)
        }
        if (mode === 'scrollback') {
          await source.write('history\r\n'.repeat(14))
        }
        checkpoint = source.captureModelCheckpoint(1024 * 1024)
        const expectedText = source.getVisibleLines()
        const expectedPixels = pixels(source)
        source.dispose()
        restored = await Probe.prepareModelCheckpoint(checkpoint)
        expect(restored.getVisibleLines()).toEqual(expectedText)
        expect(pixels(restored)).toEqual(expectedPixels)
        expect(restored.getAppliedSize()).toEqual({ cols: 20, rows: 10 })
      } finally {
        checkpoint?.dispose()
        restored?.dispose()
        source.dispose()
      }
    }
  )

  it.each(['kitty', 'iip', 'sixel', 'csi', 'kitty-c1', 'iip-c1', 'sixel-c1'])(
    'continues active %s without replaying its input',
    async (protocol) => {
      const source = new Probe(options)
      let checkpoint, restored
      const baseProtocol = protocol.replace('-c1', '')
      let command =
        baseProtocol === 'kitty'
          ? kitty(7)
          : baseProtocol === 'sixel'
            ? '\x1bPq"1;1;8;6#1;2;100;0;0#1!8~\x1b\\'
            : baseProtocol === 'iip'
              ? `\x1b]1337;File=inline=1;width=2px;height=2px:${png}\x07`
              : '\x1b[32mAFTER'
      if (protocol.endsWith('-c1')) {
        command = command
          .replace('\x1bP', '\u0090')
          .replace('\x1b]', '\u009d')
          .replace('\x1b_', '\u009f')
          .replace('\x1b\\', '\u009c')
          .replace('\x07', '\u009c')
      }
      const cut =
        baseProtocol === 'iip'
          ? command.length - 5
          : baseProtocol === 'csi'
            ? 3
            : command.length - 4
      try {
        await source.write(`BEFORE${command.slice(0, cut)}`)
        checkpoint = source.captureModelCheckpoint(1024 * 1024)
        restored = await Probe.prepareModelCheckpoint(checkpoint)
        checkpoint.dispose()
        await source.write(`${command.slice(cut)}END`)
        await restored.write(`${command.slice(cut)}END`)
        expect(restored.getVisibleLines()).toEqual(source.getVisibleLines())
        expect(pixels(source)).toHaveLength(baseProtocol === 'csi' ? 0 : 1)
        expect(pixels(restored)).toEqual(pixels(source))
        expect(restored.core.buffer.active.cursorX).toBe(source.core.buffer.active.cursorX)
        expect(restored.core.buffer.active.cursorY).toBe(source.core.buffer.active.cursorY)
      } finally {
        checkpoint?.dispose()
        restored?.dispose()
        source.dispose()
      }
    }
  )

  it.each(['kitty', 'iip', 'sixel'])(
    'continues split C1 %s headers at every header boundary',
    async (protocol) => {
      const command =
        protocol === 'kitty'
          ? kitty(7).replace('\x1b_', '\u009f').replace('\x1b\\', '\u009c')
          : protocol === 'iip'
            ? `\u009d1337;File=inline=1;width=2px;height=2px:${png}\u009c`
            : '\u0090q"1;1;8;6#1;2;100;0;0#1!8~\u009c'
      const end =
        protocol === 'kitty'
          ? command.indexOf(';')
          : protocol === 'iip'
            ? command.indexOf(':')
            : command.indexOf('q') + 1
      for (let cut = 1; cut <= end; cut++) {
        const source = new Probe(options)
        let checkpoint, restored
        try {
          await source.write(command.slice(0, cut))
          checkpoint = source.captureModelCheckpoint(1024 * 1024)
          restored = await Probe.prepareModelCheckpoint(checkpoint)
          await source.write(command.slice(cut))
          await restored.write(command.slice(cut))
          expect(pixels(source)).toHaveLength(1)
          expect(pixels(restored), `header cut ${cut}`).toEqual(pixels(source))
          expect(restored.getVisibleLines(), `header cut ${cut}`).toEqual(source.getVisibleLines())
        } finally {
          checkpoint?.dispose()
          restored?.dispose()
          source.dispose()
        }
      }
    }
  )

  it('charges text and graphics to one budget without changing the source', async () => {
    const source = new Probe(options)
    let checkpoint
    try {
      await source.write('history\r\n'.repeat(15) + kitty(7))
      checkpoint = source.captureModelCheckpoint(1024 * 1024)
      const before = source.getSnapshot()
      expect(() => source.captureModelCheckpoint(checkpoint.metadata.byteLength - 1)).toThrow(
        /budget/
      )
      expect(source.getSnapshot()).toEqual(before)
      expect(checkpoint.metadata.byteLength).toBeGreaterThan(
        checkpoint.metadata.graphics.byteLength
      )
    } finally {
      checkpoint?.dispose()
      source.dispose()
    }
  })

  it('rejects a capture while an asynchronous parser write has not drained', async () => {
    const source = new Probe(options)
    const original = source.core._core.writeSync
    let finish
    source.core._core.writeSync = undefined
    vi.spyOn(source.core, 'write').mockImplementation((_data, callback) => {
      finish = callback
    })
    try {
      const write = source.write('PENDING')
      expect(() => source.captureModelCheckpoint(1024 * 1024)).toThrow(/drain/)
      finish()
      await write
      const checkpoint = source.captureModelCheckpoint(1024 * 1024)
      checkpoint.dispose()
    } finally {
      vi.restoreAllMocks()
      source.core._core.writeSync = original
      source.dispose()
    }
  })
  it('owns a JSON checkpoint and resources after the producer and first lease are disposed', async () => {
    const source = new Probe(options)
    let checkpoint, wire, restored
    try {
      await source.write(`saved${kitty(7)}\x1b]7;file:///owned\x07`)
      source.addon.showPlaceholder = false
      checkpoint = source.captureModelCheckpoint(1024 * 1024)
      const metadata = JSON.parse(JSON.stringify(checkpoint.metadata))
      wire = new HeadlessModelCheckpoint(
        metadata,
        new Map(
          metadata.graphics.resources.map((r) => [
            r.id,
            checkpoint.copyResource(r.id, r.byteLength)
          ])
        )
      )
      const expected = pixels(source)
      metadata.snapshot.snapshotAnsi = 'MUTATED'
      metadata.configuration.images.cellSize.width = 900
      checkpoint.dispose()
      source.dispose()
      restored = await Probe.prepareModelCheckpoint(wire)
      expect(restored.getVisibleLines()[0]).toContain('saved')
      expect(restored.getCwd()).toBe('/owned')
      expect(restored.addon.showPlaceholder).toBe(false)
      expect(pixels(restored)).toEqual(expected)
      expect(wire.metadata.configuration.images.cellSize.width).toBe(2)
    } finally {
      checkpoint?.dispose()
      wire?.dispose()
      restored?.dispose()
      source.dispose()
    }
  })

  it.each(['lease', 'owner'])(
    'closes staged pixels on %s invalidation while preserving the live model',
    async (action) => {
      const source = new Probe(options)
      let checkpoint, closed
      let current = true
      try {
        await source.write(kitty(7))
        const old = pixels(source)
        checkpoint = source.captureModelCheckpoint(1024 * 1024)
        const from = NodeTerminalRasterBackend.prototype.fromRgba
        vi.spyOn(NodeTerminalRasterBackend.prototype, 'fromRgba').mockImplementation(function (
          ...args
        ) {
          const raster = from.apply(this, args)
          closed = vi.spyOn(raster, 'close')
          if (action === 'lease') {
            checkpoint.dispose()
          } else {
            current = false
          }
          return raster
        })
        await expect(
          Probe.prepareModelCheckpoint(checkpoint, { isCurrent: () => current })
        ).rejects.toThrow()
        expect(closed).toHaveBeenCalledTimes(1)
        expect(pixels(source)).toEqual(old)
      } finally {
        vi.restoreAllMocks()
        checkpoint?.dispose()
        source.dispose()
      }
    }
  )

  it('rejects an already expired lease without constructing any staging terminal', async () => {
    const source = new Probe(options)
    let checkpoint
    try {
      checkpoint = source.captureModelCheckpoint(1024 * 1024)
      checkpoint.dispose()
      const dispose = vi.spyOn(Probe.prototype, 'dispose')
      await expect(Probe.prepareModelCheckpoint(checkpoint)).rejects.toThrow(/disposed/)
      expect(dispose).not.toHaveBeenCalled()
      expect(() => checkpoint.metadata).toThrow(/disposed/)
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.dispose()
    }
  })

  it('rejects an insufficient text budget before capturing any image copies', async () => {
    const source = new Probe(options)
    try {
      await source.write(`visible${kitty(7)}`)
      const capture = vi.spyOn(source.addon, 'captureCheckpoint')
      expect(() => source.captureModelCheckpoint(1)).toThrow(/budget/)
      expect(capture).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      source.dispose()
    }
  })
  it.each([new Error('Submission failed'), undefined])(
    'releases the drain guard when an asynchronous write rejects with %s',
    async (failure) => {
      const source = new Probe(options)
      const original = source.core._core.writeSync
      source.core._core.writeSync = undefined
      vi.spyOn(source.core, 'write').mockImplementation(() => {
        throw failure
      })
      try {
        await expect(source.write('REJECTED')).rejects.toBe(failure)
        const checkpoint = source.captureModelCheckpoint(1024 * 1024)
        checkpoint.dispose()
      } finally {
        vi.restoreAllMocks()
        source.core._core.writeSync = original
        source.dispose()
      }
    }
  )

  it('keeps a late reply-window callback inert after a failed write submission', async () => {
    const reply = vi.fn()
    const source = new Probe({ ...options, onQueryReply: reply })
    const original = source.core._core.writeSync
    let enter
    source.core._core.writeSync = undefined
    vi.spyOn(source.core, 'write').mockImplementation((data, callback) => {
      if (data === '') {
        enter = callback
        return
      }
      throw new Error('Submission failed')
    })
    try {
      await expect(source.write('REJECTED', { forwardQueryReplies: true })).rejects.toThrow(
        'Submission failed'
      )
      enter()
      source.core._core.coreService.triggerDataEvent('LATE REPLY')
      expect(reply).not.toHaveBeenCalled()
      const checkpoint = source.captureModelCheckpoint(1024 * 1024)
      checkpoint.dispose()
    } finally {
      vi.restoreAllMocks()
      source.core._core.writeSync = original
      source.dispose()
    }
  })
  it.each([
    [
      'C1 SIXEL input in text',
      (m) => {
        m.snapshot.snapshotAnsi += '\u0090q!8~\u009c'
      }
    ],
    [
      'C1 IIP input in text',
      (m) => {
        m.snapshot.snapshotAnsi += '\u009d1337;File=inline=1:AAAA\u009c'
      }
    ],
    [
      'C1 Kitty input in text',
      (m) => {
        m.snapshot.snapshotAnsi += '\u009fGa=T,f=32,s=2,v=2;AAAA\u009c'
      }
    ],
    [
      'invalid geometry',
      (m) => {
        m.configuration.cols = 0
      }
    ],
    [
      'invalid cell metrics',
      (m) => {
        m.configuration.images.cellSize.width = 0
      }
    ],
    [
      'oversized scrollback',
      (m) => {
        m.configuration.scrollback = 50001
      }
    ],
    [
      'invalid colors',
      (m) => {
        m.configuration.images.colors.background.rgba = 2 ** 32
      }
    ],
    [
      'oversized decoder limits',
      (m) => {
        m.configuration.images.options.sixelSizeLimit = 9 * 1024 * 1024
      }
    ],
    [
      'image input in text',
      (m) => {
        m.snapshot.snapshotAnsi += '\x1b_Ga=T,f=32,s=2,v=2;AAAA\x1b\\'
      }
    ],
    [
      'completed parser tail',
      (m) => {
        m.snapshot.pendingEscapeTailAnsi = '\x1b[32m'
      }
    ],
    [
      'duplicate parser ownership',
      (m) => {
        m.snapshot.pendingEscapeTailAnsi = '\x1b['
      }
    ],
    [
      'invalid resource descriptor',
      (m) => {
        m.graphics.resources[0].byteLength -= 1
      }
    ]
  ])('rejects %s and releases transferred resources before staging', async (_name, change) => {
    const source = new Probe(options)
    let checkpoint
    try {
      await source.write(`${kitty(7)}\x1b_Ga=T,f=32,s=2,v=2,i=8,q=2;AAAA`)
      checkpoint = source.captureModelCheckpoint(1024 * 1024)
      const metadata = JSON.parse(JSON.stringify(checkpoint.metadata))
      const resources = new Map(
        metadata.graphics.resources.map((r) => [r.id, checkpoint.copyResource(r.id, r.byteLength)])
      )
      change(metadata)
      metadata.metadataByteLength = imageCheckpointMetadataBytes(metadata)
      metadata.byteLength = metadata.graphics.resourceByteLength + metadata.metadataByteLength
      const allocate = vi.spyOn(NodeTerminalRasterBackend.prototype, 'fromRgba')
      expect(() => new HeadlessModelCheckpoint(metadata, resources)).toThrow()
      expect(resources.size).toBe(0)
      expect(allocate).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.dispose()
    }
  })
  it('preserves named Unicode placeholders and their sources through a complete model restore', async () => {
    const source = new Probe(options)
    let checkpoint, restored
    try {
      await source.write(
        `\x1b_Ga=T,f=100,i=7,U=1,p=10,c=2,r=2,q=2;${png}\x1b\\${placeholderCells(7, 10)}`
      )
      const before = source.getVisibleLines()
      checkpoint = source.captureModelCheckpoint(1024 * 1024)
      restored = await Probe.prepareModelCheckpoint(checkpoint)
      expect(restored.getVisibleLines()).toEqual(before)
      expect(pixels(source)).toHaveLength(1)
      expect(pixels(restored)).toEqual(pixels(source))
      for (const [row, col] of [
        [0, 0],
        [1, 1]
      ]) {
        const a = source.core.buffer.active.getLine(row).getCell(col)
        const b = restored.core.buffer.active.getLine(row).getCell(col)
        expect(a.getChars().codePointAt(0)).toBe(0x10eeee)
        expect(a.getFgColor()).toBe(7)
        expect(a.getUnderlineColor()).toBe(10)
        expect(b.getChars()).toBe(a.getChars())
        expect(b.getFgColor()).toBe(a.getFgColor())
        expect(b.getUnderlineColor()).toBe(a.getUnderlineColor())
      }
    } finally {
      checkpoint?.dispose()
      restored?.dispose()
      source.dispose()
    }
  })
})
