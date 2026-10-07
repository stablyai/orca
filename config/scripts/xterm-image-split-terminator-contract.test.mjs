import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'
import { advancePartialEscapeTail } from '../../src/shared/terminal-partial-escape-tail'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const write = (h, sequence) => h.core._core.writeSync(sequence)
const text = (h) =>
  Array.from({ length: h.core.buffer.active.length }, (_, row) =>
    h.core.buffer.active.getLine(row).translateToString(true)
  )

function image(protocol, large) {
  if (protocol === 'SIXEL') {
    return `\x1bPq"1;1;8;6${'#0;2;100;0;0'.repeat(large ? 500 : 1)}#0!8~\x1b`
  }
  const size = large ? 200 : 2
  const rgba = Buffer.alloc(size * size * 4, 255)
  if (protocol === 'Kitty') {
    return `\x1b_Ga=T,f=32,s=${size},v=${size},i=7,c=4,r=4;${rgba.toString('base64')}\x1b`
  }
  const png = new PNG({ width: size, height: size })
  png.data.set(rgba)
  const encoded = PNG.sync.write(png, { deflateLevel: 0 }).toString('base64')
  return `\x1b]1337;File=inline=1;width=8px;height=8px:${encoded}\x1b`
}

describe('image checkpoint at a split string terminator', () => {
  it.each(
    [32, 5000].flatMap((length) =>
      ['\\AFTER', '[32mAFTER', '\x18AFTER'].map((continuation) => [length, continuation])
    )
  )('does not repeat a completed %i-character title before %j', (length, continuation) => {
    const source = terminal(),
      target = terminal()
    try {
      const sourceTitle = vi.fn(),
        targetTitle = vi.fn()
      source.core.onTitleChange(sourceTitle)
      target.core.onTitleChange(targetTitle)
      const prefix = `BEFORE\x1b]2;${'x'.repeat(length)}\x1b`
      write(source, prefix)
      expect(sourceTitle).toHaveBeenCalledTimes(1)
      const ansi = source.serializer.serialize()
      write(source, continuation)
      write(target, `${ansi}${advancePartialEscapeTail('', prefix)}${continuation}`)
      expect(text(target)).toEqual(text(source))
      expect([target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]).toEqual([
        source.core.buffer.active.cursorX,
        source.core.buffer.active.cursorY
      ])
      expect(targetTitle).not.toHaveBeenCalled()
    } finally {
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(
    ['Kitty', 'IIP', 'SIXEL'].flatMap((protocol) => [
      [protocol, false],
      [protocol, true]
    ])
  )('restores %s (large=%s) without replaying its completed command', async (protocol, large) => {
    const source = terminal(),
      target = terminal()
    let decoded, kitty
    try {
      const prefix = `BEFORE${image(protocol, large)}`
      write(source, prefix)
      expect(source.storage._images.size).toBe(1)
      decoded = source.storage.captureCheckpoint(1024 * 1024)
      kitty = source.kittyStorage.captureCheckpoint(1024 * 1024)
      const ansi = source.serializer.serialize()
      const tail = advancePartialEscapeTail('', prefix)
      write(source, '\\AFTER')
      const expectedText = text(source)
      const expectedCursor = [source.core.buffer.active.cursorX, source.core.buffer.active.cursorY]
      source.core.dispose()

      write(target, ansi)
      await target.storage.restoreCheckpoint(decoded)
      target.kittyStorage.restoreCheckpoint(kitty, 8 * 1024 * 1024)
      const restored = [...target.storage._images.entries()]
      const reply = vi.fn()
      target.core.onData(reply)
      write(target, `${tail}\\AFTER`)
      expect(text(target)).toEqual(expectedText)
      expect([target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]).toEqual(
        expectedCursor
      )
      expect([...target.storage._images.keys()]).toEqual(restored.map(([id]) => id))
      for (const [id, spec] of restored) {
        expect(target.storage._images.get(id)).toBe(spec)
      }
      expect(reply).not.toHaveBeenCalled()
    } finally {
      decoded?.dispose()
      kitty?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })
})
