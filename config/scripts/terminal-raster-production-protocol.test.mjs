import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../src/shared/__fixtures__/terminal-raster-red.json'
import { NodeTerminalRasterBackend } from '../../src/shared/node-terminal-raster-backend'
import { releaseTerminalRasterDecoder } from '../../src/shared/terminal-raster-wasm-decoder'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const { ImageAddon } = require('@xterm/addon-image')
afterEach(releaseTerminalRasterDecoder)

function terminal() {
  const core = new Terminal({ cols: 20, rows: 10, allowProposedApi: true, logLevel: 'off' })
  const backend = new NodeTerminalRasterBackend({
    getCellSize: () => ({ width: 2, height: 2 }),
    getColors: () => ({
      foreground: { rgba: 0xffffffff },
      background: { rgba: 0x000000ff },
      ansi: []
    })
  })
  const addon = new ImageAddon({
    rasterBackend: backend,
    pixelLimit: 8_000_000,
    enableSizeReports: false
  })
  core.loadAddon(addon)
  return { core, addon }
}

function kitty(command, bytes) {
  return `\x1b_G${command};${Buffer.from(bytes).toString('base64')}\x1b\\`
}

const compactQoi = Buffer.from('716f696600000008000000080400ffff0000fffdc00000000000000001', 'hex')

const sequences = [
  [
    'IIP compact QOI',
    `\x1b]1337;File=inline=1;width=8px;height=8px:${compactQoi.toString('base64')}\x07`
  ],
  ...Object.keys(fixtures).map((format) => [
    `IIP ${format}`,
    `\x1b]1337;File=inline=1;width=8px;height=8px:${fixtures[format]}\x07`
  ]),
  ['Kitty PNG', kitty('a=T,f=100,i=7,q=2', Buffer.from(fixtures.png, 'base64'))],
  [
    'Kitty raw',
    kitty(
      'a=T,f=32,s=8,v=8,i=7,q=2',
      Buffer.from(Array.from({ length: 64 }, () => [255, 0, 0, 255]).flat())
    )
  ],
  [
    'Kitty zlib',
    kitty(
      'a=T,f=32,s=8,v=8,i=7,o=z,q=2',
      deflateSync(Buffer.from(Array.from({ length: 64 }, () => [255, 0, 0, 255]).flat()))
    )
  ],
  ['SIXEL', '\x1bPq"1;1;8;6#0;2;100;0;0#0!8~\x1b\\']
]

describe('production raster backend in the headless terminal parser', () => {
  it.each(sequences)(
    '%s stores pixels and consumes following text synchronously',
    (_name, sequence) => {
      const h = terminal()
      try {
        expect(typeof document).toBe('undefined')
        expect(typeof createImageBitmap).toBe('undefined')
        h.core._core.writeSync(`BEFORE${sequence}AFTER`)
        expect(h.addon._storage._images.size).toBe(1)
        const raster = [...h.addon._storage._images.values()][0].orig
        expect(raster.kind).toBe('rgba')
        expect(raster.data[0]).toBeGreaterThanOrEqual(245)
        expect(raster.data[1]).toBeLessThanOrEqual(10)
        expect(raster.data[3]).toBe(255)
        expect(
          Array.from({ length: 10 }, (_, row) =>
            h.core.buffer.active.getLine(row).translateToString(true)
          ).join('\n')
        ).toContain('AFTER')
        h.addon.reset()
        expect(raster.data.byteLength).toBe(0)
      } finally {
        h.core.dispose()
      }
    }
  )

  it.each([
    [
      'minimum QOI',
      Buffer.from('716f696600000001000000010300c00000000000000001', 'hex'),
      [0, 0, 0, 255]
    ],
    [
      'RGB, diff, luma, index and run QOI',
      Buffer.from('716f696600000006000000010301fe1002037fa18704c10000000000000001', 'hex'),
      [16, 2, 3, 255, 17, 3, 4, 255, 18, 4, 4, 255, 16, 2, 3, 255, 16, 2, 3, 255, 16, 2, 3, 255]
    ]
  ])('%s preserves every pixel and consumes the suffix', (_name, bytes, expected) => {
    const h = terminal()
    try {
      h.core._core.writeSync(`\x1b]1337;File=inline=1:${bytes.toString('base64')}\x07AFTER`)
      expect(h.addon._storage._images.size).toBe(1)
      expect([...h.addon._storage._images.values()][0].orig.data).toEqual(
        new Uint8ClampedArray(expected)
      )
      expect(
        Array.from({ length: 10 }, (_, row) =>
          h.core.buffer.active.getLine(row).translateToString(true)
        ).join('\n')
      ).toContain('AFTER')
    } finally {
      h.core.dispose()
    }
  })

  it.each([
    ['header only', compactQoi.subarray(0, 14)],
    ['truncated end marker', compactQoi.subarray(0, 28)],
    [
      'missing RGBA bytes',
      Buffer.concat([
        compactQoi.subarray(0, 14),
        Buffer.from([255, 255, 0]),
        compactQoi.subarray(-8)
      ])
    ],
    ['short pixel stream', Buffer.concat([compactQoi.subarray(0, 19), compactQoi.subarray(-8)])],
    [
      'long pixel stream',
      Buffer.concat([compactQoi.subarray(0, 20), Buffer.from([193]), compactQoi.subarray(-8)])
    ],
    [
      'missing luma byte',
      Buffer.concat([compactQoi.subarray(0, 14), Buffer.from([128]), compactQoi.subarray(-8)])
    ],
    [
      'extra encoded pixel',
      Buffer.concat([compactQoi.subarray(0, -8), Buffer.from([0]), compactQoi.subarray(-8)])
    ],
    ['invalid channels', Buffer.from(compactQoi).fill(2, 12, 13)],
    ['invalid color space', Buffer.from(compactQoi).fill(2, 13, 14)],
    [
      'negative signed dimensions',
      Buffer.from(compactQoi).fill(255, 4, 12).fill(248, 7, 8).fill(248, 11, 12)
    ],
    ['invalid end marker', Buffer.from(compactQoi).fill(0, 28, 29)]
  ])('drops QOI with %s and accepts the next image', (_name, bytes) => {
    const h = terminal()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      h.core._core.writeSync(`BEFORE\x1b]1337;File=inline=1:${bytes.toString('base64')}\x07AFTER`)
      expect(h.addon._storage._images.size).toBe(0)
      expect(h.core.buffer.active.getLine(0).translateToString(true)).toBe('BEFOREAFTER')
      h.core._core.writeSync(`\x1b]1337;File=inline=1:${compactQoi.toString('base64')}\x07VALID`)
      expect(h.addon._storage._images.size).toBe(1)
      expect(warning).toHaveBeenCalledOnce()
      expect(
        Array.from({ length: 10 }, (_, row) =>
          h.core.buffer.active.getLine(row).translateToString(true)
        ).join('\n')
      ).toContain('VALID')
    } finally {
      warning.mockRestore()
      h.core.dispose()
    }
  })

  it('applies crop, resize and offsets without losing the suffix or retaining intermediates', () => {
    const h = terminal()
    try {
      h.core._core.writeSync(
        `\x1b[3;4H${kitty('a=T,f=100,i=7,x=1,y=1,w=2,h=2,c=2,r=2,X=1,Y=1,C=1,q=2', Buffer.from(fixtures.png, 'base64'))}AFTER`
      )
      const source = [...h.addon._storage._images.values()][0].orig
      expect([source.width, source.height]).toEqual([4, 4])
      expect([...source.data.subarray(0, 4)]).toEqual([0, 0, 0, 0])
      expect([...source.data.subarray(20, 24)]).toEqual([255, 0, 0, 255])
      expect(h.core.buffer.active.getLine(2).translateToString(true)).toBe('   AFTER')
      h.core.dispose()
      expect(source.data.byteLength).toBe(0)
    } finally {
      h.core.dispose()
    }
  })

  it('rejects a partial GIF without interrupting text or the next valid image', () => {
    const h = terminal()
    const error = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The 1x1 frame contains two pixels in its LZW stream.
      const gif = Buffer.from(
        '47494638396101000100800000ff000000ff002c0000000001000100000202440a003b',
        'hex'
      )
      h.core._core.writeSync(`BEFORE\x1b]1337;File=inline=1:${gif.toString('base64')}\x07AFTER`)
      expect(h.addon._storage._images.size).toBe(0)
      expect(h.core.buffer.active.getLine(0).translateToString(true)).toBe('BEFOREAFTER')
      h.core._core.writeSync(`\x1b]1337;File=inline=1:${fixtures.gif}\x07VALID`)
      expect(h.addon._storage._images.size).toBe(1)
      expect(error).toHaveBeenCalledOnce()
      expect(
        Array.from({ length: 10 }, (_, row) =>
          h.core.buffer.active.getLine(row).translateToString(true)
        ).join('\n')
      ).toContain('VALID')
    } finally {
      error.mockRestore()
      h.core.dispose()
    }
  })
})
