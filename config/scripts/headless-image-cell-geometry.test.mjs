import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { HeadlessEmulator } from '../../src/main/daemon/headless-emulator'

const options = {
  cols: 20,
  rows: 10,
  images: {
    cellSize: { width: 2, height: 2 },
    colors: {
      foreground: { rgba: 0xffffffff },
      background: { rgba: 0x000000ff },
      ansi: []
    }
  }
}
const measured = { width: 3.25, height: 4.5 }
const png = JSON.parse(
  readFileSync(new URL('../../src/shared/__fixtures__/terminal-raster-red.json', import.meta.url))
).png
const commands = {
  kitty: `\x1b_Ga=T,f=32,s=6,v=6,i=7,q=2;${Buffer.alloc(144, 255).toString('base64')}\x1b\\`,
  sixel: '\x1bPq"1;1;6;6#1;2;100;0;0#1!6~\x1b\\',
  iip: `\x1b]1337;File=inline=1;width=2;height=1;preserveAspectRatio=0:${png}\x07`
}
class Probe extends HeadlessEmulator {
  images() {
    return [...this.imageAddon._storage._images.values()].map((image) => ({
      cellSize: image.origCellSize,
      width: image.orig.width,
      height: image.orig.height,
      pixels: Array.from(image.orig.data)
    }))
  }
  cursor() {
    return [this.terminal.buffer.active.cursorX, this.terminal.buffer.active.cursorY]
  }
}
const models = []
function create(cellSize = options.images.cellSize) {
  const model = new Probe({ ...options, images: { ...options.images, cellSize } })
  models.push(model)
  return model
}
afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose()
  }
})

describe('headless image cell geometry', () => {
  it.each(Object.keys(commands))(
    'uses a same-grid font change for %s pixels and cells',
    async (p) => {
      const model = create()
      const control = create(measured)
      await model.write('BEFORE\r\n')
      await control.write('BEFORE\r\n')
      model.resize(20, 10, measured)
      await model.write(`${commands[p]}AFTER`)
      await control.write(`${commands[p]}AFTER`)
      expect(model.images()).toHaveLength(1)
      expect(model.images()).toEqual(control.images())
      expect(model.cursor()).toEqual(control.cursor())
      expect(model.getVisibleLines()).toEqual(control.getVisibleLines())
    }
  )

  it('owns fractional measurements without mutating existing image geometry', async () => {
    const model = create()
    await model.write(commands.kitty)
    const old = structuredClone(model.images()[0])
    const supplied = { ...measured }
    model.resize(20, 10, supplied)
    supplied.width = 100
    await model.write(commands.kitty.replace('i=7', 'i=8'))
    expect(model.images()[0]).toEqual(old)
    expect(model.images()[1].cellSize).toEqual(measured)
    const lease = model.captureModelCheckpoint(1024 * 1024)
    try {
      expect(lease.metadata.configuration.images.cellSize).toEqual(measured)
    } finally {
      lease.dispose()
    }
  })

  it.each(Object.keys(commands))(
    'keeps active %s input through a calibrated checkpoint',
    async (p) => {
      const source = create()
      const command = commands[p]
      const cut = command.length - 4
      await source.write(`BEFORE${command.slice(0, cut)}`)
      source.resize(20, 10, measured)
      const lease = source.captureModelCheckpoint(1024 * 1024)
      try {
        expect(lease.metadata.configuration.images.cellSize).toEqual(measured)
        const restored = await Probe.prepareModelCheckpoint(lease)
        models.push(restored)
        lease.dispose()
        await source.write(`${command.slice(cut)}AFTER`)
        await restored.write(`${command.slice(cut)}AFTER`)
        expect(restored.images()).toEqual(source.images())
        expect(restored.images()[0].cellSize).toEqual(measured)
        expect(restored.cursor()).toEqual(source.cursor())
        expect(restored.getVisibleLines()).toEqual(source.getVisibleLines())
      } finally {
        lease.dispose()
      }
    }
  )
})
