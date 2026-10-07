import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../../src/main/daemon/headless-emulator'

const options = {
  cols: 20,
  rows: 10,
  images: {
    cellSize: { width: 2, height: 2 },
    colors: {
      foreground: { rgba: 0xc8c8c8ff },
      background: { rgba: 0x0a0a0aff },
      ansi: Array.from({ length: 256 }, () => ({ rgba: 0x141414ff }))
    }
  }
}
const theme = {
  foreground: [200, 200, 200],
  background: [10, 10, 10],
  cursor: [200, 200, 200],
  ansi: Array.from({ length: 256 }, () => [20, 20, 20]),
  cursorStyle: 'bar',
  cursorBlink: false,
  colorSchemeMode: 'dark'
}
const sixel = '\x1bPq"1;1;2;6#1;2;100;0;0#1?~\x1b\\'
class Probe extends HeadlessEmulator {
  backgroundPixel() {
    const images = [...this.imageAddon._storage._images.values()]
    const raster = images.at(-1)?.orig
    if (!raster) {
      throw new Error('Expected decoded image')
    }
    return Array.from(raster.data.subarray(0, 4))
  }
}
const models = []
function createModel(onQueryReply) {
  const model = new Probe({ ...options, onQueryReply })
  models.push(model)
  return model
}
afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose()
  }
})

describe('headless image color authority', () => {
  it.each([
    ['default background', '\x1b]11;#00ff00\x07', [0, 255, 0, 255]],
    ['indexed background', '\x1b]4;7;#00ff00\x07\x1b[48;5;7m', [0, 255, 0, 255]],
    ['extended indexed background', '\x1b]4;255;#ff00ff\x07\x1b[48;5;255m', [255, 0, 255, 255]],
    ['inverse foreground', '\x1b]10;#ffff00\x07\x1b[7m', [255, 255, 0, 255]]
  ])('uses current %s mutations in decoded pixels', async (_name, prefix, expected) => {
    const model = createModel()
    model.installViewAttributeResponder(() => theme)
    await model.write(prefix + sixel)
    expect(model.backgroundPixel()).toEqual(expected)
  })

  it('tracks standalone mutations without fabricating query replies', async () => {
    const reply = vi.fn()
    const model = createModel(reply)
    await model.write(`\x1b]11;#00ff00\x07${sixel}`)
    expect(model.backgroundPixel()).toEqual([0, 255, 0, 255])
    await model.write('\x1b]11;?\x07', { forwardQueryReplies: true })
    expect(reply).not.toHaveBeenCalled()
    await model.write(`\x1b]111\x07${sixel}`)
    expect(model.backgroundPixel()).toEqual([10, 10, 10, 255])
  })

  it('uses new base colors after a theme apply and drops old overrides', async () => {
    const model = createModel()
    let base = theme
    model.installViewAttributeResponder(() => base)
    await model.write(`\x1b]11;#00ff00\x07${sixel}`)
    base = { ...theme, background: [0, 0, 255] }
    model.applyPushedViewAttributes(base)
    await model.write(sixel)
    expect(model.backgroundPixel()).toEqual([0, 0, 255, 255])
  })

  it('captures the current base separately from overrides for a later reset', async () => {
    const source = createModel()
    const base = { ...theme, background: [0, 0, 255] }
    source.installViewAttributeResponder(() => base)
    source.applyPushedViewAttributes(base)
    await source.write('\x1b]11;#00ff00\x07')
    const lease = source.captureModelCheckpoint(1024 * 1024)
    try {
      expect(lease.metadata.configuration.images.colors.background.rgba).toBe(0x0000ffff)
      const restored = await Probe.prepareModelCheckpoint(lease)
      models.push(restored)
      lease.dispose()
      source.dispose()
      await restored.write(sixel)
      expect(restored.backgroundPixel()).toEqual([0, 255, 0, 255])
      await restored.write(`\x1b]111\x07${sixel}`)
      expect(restored.backgroundPixel()).toEqual([0, 0, 255, 255])
    } finally {
      lease.dispose()
    }
  })

  it('keeps two models color mutations independent', async () => {
    const first = createModel()
    const second = createModel()
    first.installViewAttributeResponder(() => theme)
    second.installViewAttributeResponder(() => theme)
    await first.write(`\x1b]11;#00ff00\x07${sixel}`)
    await second.write(sixel)
    expect(first.backgroundPixel()).toEqual([0, 255, 0, 255])
    expect(second.backgroundPixel()).toEqual([10, 10, 10, 255])
  })

  it.each([
    ['indexed reset', '\x1b]4;7;#00ff00\x07\x1b]104;7\x07\x1b[48;5;7m', [20, 20, 20, 255]],
    ['all indexed reset', '\x1b]4;7;#00ff00\x07\x1b]104\x07\x1b[48;5;7m', [20, 20, 20, 255]],
    ['foreground reset', '\x1b]10;#00ff00\x07\x1b]110\x07\x1b[7m', [200, 200, 200, 255]],
    ['invalid mutation', '\x1b]11;bad-color\x07', [10, 10, 10, 255]],
    ['explicit RGB background', '\x1b]11;#00ff00\x07\x1b[48;2;123;45;67m', [123, 45, 67, 255]],
    ['inverse indexed foreground', '\x1b]4;7;#00ff00\x07\x1b[38;5;7;7m', [0, 255, 0, 255]]
  ])('preserves %s semantics', async (_name, prefix, expected) => {
    const model = createModel()
    model.installViewAttributeResponder(() => theme)
    await model.write(prefix + sixel)
    expect(model.backgroundPixel()).toEqual(expected)
  })

  it('leaves transparent SIXEL pixels transparent despite color overrides', async () => {
    const model = createModel()
    model.installViewAttributeResponder(() => theme)
    await model.write(`\x1b]11;#00ff00\x07${sixel.replace('\x1bPq', '\x1bP0;1q')}`)
    expect(model.backgroundPixel()).toEqual([0, 0, 0, 0])
  })

  it('retargets one responder without duplicating queries or discarding mutations', async () => {
    const reply = vi.fn()
    const model = createModel(reply)
    model.installViewAttributeResponder(() => theme)
    await model.write('\x1b]11;#00ff00\x07')
    model.installViewAttributeResponder(() => ({ ...theme, background: [0, 0, 255] }))
    await model.write(`\x1b]11;?\x07${sixel}`, { forwardQueryReplies: true })
    expect(reply.mock.calls).toEqual([['\x1b]11;rgb:0000/ffff/0000\x1b\\']])
    expect(model.backgroundPixel()).toEqual([0, 255, 0, 255])
    await model.write(`\x1b]111\x07${sixel}`)
    expect(model.backgroundPixel()).toEqual([0, 0, 255, 255])
  })

  it('preserves the active decoder fill and the new base for future images', async () => {
    const source = createModel()
    const base = { ...theme, background: [0, 0, 255] }
    source.installViewAttributeResponder(() => base)
    await source.write(`\x1b]11;#00ff00\x07${sixel.slice(0, -3)}`)
    const lease = source.captureModelCheckpoint(1024 * 1024)
    try {
      const restored = await Probe.prepareModelCheckpoint(lease)
      models.push(restored)
      lease.dispose()
      source.dispose()
      await restored.write(sixel.slice(-3))
      expect(restored.backgroundPixel()).toEqual([0, 255, 0, 255])
      await restored.write(`\x1b]111\x07${sixel}`)
      expect(restored.backgroundPixel()).toEqual([0, 0, 255, 255])
    } finally {
      lease.dispose()
    }
  })
})
