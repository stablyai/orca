import type { NativeImage } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { MacMenuBarTray } from './mac-menu-bar-tray'

const { update } = vi.hoisted(() => ({ update: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: true },
  powerMonitor: { on: vi.fn(), off: vi.fn() }
}))
vi.mock('./mac-menu-bar-process', () => ({
  MacMenuBarProcess: class {
    update = update
    destroy = () => Promise.resolve()
  }
}))

let tray: MacMenuBarTray | undefined
afterEach(async () => {
  await tray?.destroy()
  update.mockClear()
})

it.each([
  [1, 2, 2],
  [1, 2]
])('publishes lossless unique image scales from Electron metadata %j', async (...scales) => {
  const image = {
    getScaleFactors: () => scales,
    toPNG: ({ scaleFactor }: { scaleFactor: number }) =>
      Buffer.from(scaleFactor === 2 ? 'retina' : 'plain'),
    isTemplateImage: () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the image supplies every NativeImage operation used by the snapshot publisher.
  tray = new MacMenuBarTray(image as unknown as NativeImage)
  tray.setToolTip('Orca')
  tray.setMenu([{ id: 'open', label: 'Open Orca' }])
  await Promise.resolve()
  expect(update.mock.calls.at(-1)?.[0]).toEqual({
    images: [
      { scale: 1, png: 'cGxhaW4=' },
      { scale: 2, png: 'cmV0aW5h' }
    ],
    template: true,
    tooltip: 'Orca',
    menu: [{ id: 'open', label: 'Open Orca' }]
  })
})
