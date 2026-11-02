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

const drawn: PluginViewReply = {
  requestId: 'r',
  ok: true,
  panel: {
    rect: { x: 0, y: 0, width: 320, height: 90 },
    ui: 'components',
    guestUrl: null,
    issue: null,
    colorScheme: 'dark',
    themeApplied: true,
    settled: true
  }
}

function answer(replay: PluginViewReply) {
  // Why optional: bun's mock runner may probe the implementation with no arguments.
  return async (...args: [unknown?, PluginViewRequestBody?, number?]): Promise<PluginViewReply> =>
    args[1]?.kind === 'replay-panel' ? replay : { requestId: 'r', ok: true }
}

beforeEach(() => relay.requestPluginViewFromRenderer.mockReset())

describe('plugins.shotReplay on the desktop', () => {
  it('draws the tree in the preview, captures it, then ends the capture', async () => {
    relay.requestPluginViewFromRenderer.mockImplementation(answer(drawn))
    const { view, capturePage } = setup()
    const shot = await view.shotReplay({ ...PARAMS, tree: TREE, colorScheme: 'dark', width: 320 })
    expect(shot).toMatchObject({
      pluginKey: 'acme.todos',
      panelId: 'todos',
      title: 'Todos',
      ui: 'components',
      png: Buffer.from('png').toString('base64'),
      width: 320,
      height: 90,
      colorScheme: 'dark',
      themeApplied: true,
      errors: [],
      replay: true,
      scenario: 'counted'
    })
    expect(capturePage).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 320, height: 90 },
      { stayHidden: true }
    )
    const kinds = relay.requestPluginViewFromRenderer.mock.calls.map(([, body]) => body)
    expect(kinds).toEqual([
      {
        kind: 'replay-panel',
        replay: { tree: TREE, width: 320, colorScheme: 'dark', timeoutMs: expect.any(Number) }
      },
      { kind: 'end-capture' }
    ])
  })

  it('never opens the panel nor reaches the plugin, its guests or its logs', async () => {
    relay.requestPluginViewFromRenderer.mockImplementation(answer(drawn))
    const { view, untouched } = setup()
    await view.shotReplay({ ...PARAMS, tree: TREE })
    for (const call of untouched) {
      expect(call).not.toHaveBeenCalled()
    }
    const kinds = relay.requestPluginViewFromRenderer.mock.calls.map(([, body]) => body.kind)
    expect(kinds).not.toContain('open-panel')
  })

  it('refuses with the window on screen, before asking the renderer anything', async () => {
    const { view } = setup({ windowShown: () => true })
    await expect(view.shotReplay({ ...PARAMS, tree: TREE })).rejects.toMatchObject({
      message: expect.stringMatching(/hidden or minimized/),
      data: { reason: 'window_shown' }
    })
    expect(relay.requestPluginViewFromRenderer).not.toHaveBeenCalled()
  })

  it('refuses a tree the declarative validator rejects', async () => {
    const { view } = setup()
    await expect(
      view.shotReplay({ ...PARAMS, tree: { type: 'Text', props: {}, children: [{ nope: 1 }] } })
    ).rejects.toMatchObject({ data: { reason: 'invalid_tree' } })
    expect(relay.requestPluginViewFromRenderer).not.toHaveBeenCalled()
  })

  it('ends the capture when the renderer cannot draw the preview', async () => {
    relay.requestPluginViewFromRenderer.mockImplementation(
      answer({ requestId: 'r', ok: false, code: 'replay_not_drawn', message: 'not drawn' })
    )
    const { view, capturePage } = setup()
    await expect(view.shotReplay({ ...PARAMS, tree: TREE })).rejects.toThrow('not drawn')
    expect(capturePage).not.toHaveBeenCalled()
    expect(relay.requestPluginViewFromRenderer.mock.calls.at(-1)?.[1]).toEqual({
      kind: 'end-capture'
    })
  })
})
