import type { NativeImage, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginViewReply,
  PluginViewRequestBody
} from '../../../shared/plugins/view/plugin-view-protocol'
import { createPluginViewDesktop, type PluginViewDesktopDeps } from './plugin-view-desktop'

const relay = vi.hoisted(() => ({
  requestPluginViewFromRenderer:
    vi.fn<
      (
        contents: unknown,
        body: PluginViewRequestBody,
        timeoutMs: number
      ) => Promise<PluginViewReply>
    >()
}))
vi.mock('./plugin-view-renderer-relay', () => relay)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these NativeImage members.
const CAPTURED = {
  isEmpty: () => false,
  getSize: () => ({ width: 320, height: 90 }),
  toBitmap: () => Buffer.from([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]),
  toPNG: () => Buffer.from('png')
} as unknown as NativeImage

const TREE = { type: 'Text', props: {}, children: ['3 counted'] }
const PARAMS = { pluginKey: 'acme.todos', panelId: 'todos', title: 'Todos', scenario: 'counted' }

function setup(overrides: Partial<PluginViewDesktopDeps> = {}) {
  const capturePage = vi.fn(async () => CAPTURED)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the replay reads only these WebContents members.
  const contents = {
    isDestroyed: () => false,
    getBackgroundThrottling: () => false,
    setBackgroundThrottling: vi.fn(),
    getZoomFactor: () => 1,
    capturePage
  } as unknown as WebContents
  const list = vi.fn(async () => [])
  const findValidPlugin = vi.fn(() => null)
  const guestsOf = vi.fn(() => [])
  const logsSince = vi.fn(() => ({ lines: [], cursor: 'n:0' }))
  const view = createPluginViewDesktop({
    rendererContents: () => contents,
    windowShown: () => false,
    source: { list, findValidPlugin },
    logsSince,
    guestsOf,
    imageFromBitmap: vi.fn(),
    ...overrides
  })
  return { view, capturePage, untouched: [list, findValidPlugin, guestsOf, logsSince] }
}

beforeEach(() => relay.requestPluginViewFromRenderer.mockReset())

describe('plugins.shotReplay on the desktop', () => {
  it('refuses with the window on screen, before asking the renderer anything', async () => {
    const { view } = setup({ windowShown: () => true })
    await expect(view.shotReplay({ ...PARAMS, tree: TREE })).rejects.toMatchObject({
      message: expect.stringMatching(/hidden or minimized/),
      data: { reason: 'window_shown' }
    })
    expect(relay.requestPluginViewFromRenderer).not.toHaveBeenCalled()
  })
})
