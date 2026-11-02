import type { NativeImage, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginViewReply,
  PluginViewRequestBody
} from '../../../shared/plugins/view/plugin-view-protocol'
import type { PluginHostListEntry } from '../../../shared/plugins/plugin-list-entry'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginViewDesktopDeps } from './plugin-view-desktop'
import { shootPluginChrome } from './plugin-view-chrome-shot'

const relay = vi.hoisted(() => ({
  requestPluginViewFromRenderer:
    vi.fn<(contents: unknown, body: PluginViewRequestBody) => Promise<PluginViewReply>>()
}))
vi.mock('./plugin-view-renderer-relay', () => relay)

const KEY = 'acme.todos'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these NativeImage members.
const CAPTURED = {
  isEmpty: () => false,
  getSize: () => ({ width: 800, height: 24 }),
  toBitmap: () => Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  toPNG: () => Buffer.from('png')
} as unknown as NativeImage

function window() {
  const capturePage = vi.fn(async () => CAPTURED)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shot reads only these WebContents members.
  const contents = {
    isDestroyed: () => false,
    getBackgroundThrottling: () => false,
    setBackgroundThrottling: vi.fn(),
    getZoomFactor: () => 1,
    capturePage
  } as unknown as WebContents
  return { contents, capturePage }
}

function deps(status = 'running', windowShown = false): PluginViewDesktopDeps {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only these members.
  const plugin = { pluginKey: KEY, manifest: { name: 'Todos' } } as unknown as ValidDiscoveredPlugin
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only pluginKey and status.
  const entry = { pluginKey: KEY, status } as PluginHostListEntry
  return {
    rendererContents: () => null,
    windowShown: () => windowShown,
    source: { list: async () => [entry], findValidPlugin: () => plugin },
    logsSince: (_key, cursor) => ({
      lines: cursor ? [{ level: 'error', line: 'status item threw' }] : [],
      cursor: 'n:1'
    }),
    guestsOf: () => [],
    imageFromBitmap: vi.fn(() => CAPTURED)
  }
}

const statusBar: PluginViewReply = {
  requestId: 'r',
  ok: true,
  panel: {
    rect: { x: 0, y: 876, width: 800, height: 24 },
    ui: 'components',
    guestUrl: null,
    issue: null,
    colorScheme: 'dark',
    themeApplied: true,
    settled: true
  }
}

// Why optional: bun's mock runner may probe the implementation with no arguments.
const answer =
  (reply: PluginViewReply) =>
  async (...args: [unknown?, PluginViewRequestBody?]): Promise<PluginViewReply> =>
    args[1]?.kind === 'capture-chrome' ? reply : { requestId: 'r', ok: true }

beforeEach(() => relay.requestPluginViewFromRenderer.mockReset())

describe('shot --status-bar', () => {
  it("captures the status bar's rect from the hidden window and puts the theme back", async () => {
    relay.requestPluginViewFromRenderer.mockImplementation(answer(statusBar))
    const { contents, capturePage } = window()
    const shot = await shootPluginChrome(deps(), contents, {
      pluginKey: KEY,
      region: 'status-bar',
      colorScheme: 'dark'
    })
    const [begun, ended] = relay.requestPluginViewFromRenderer.mock.calls.map((call) => call[1])
    expect(begun).toEqual({
      kind: 'capture-chrome',
      region: 'status-bar',
      colorScheme: 'dark',
      captureId: expect.any(String)
    })
    // Ends only this shot's overrides.
    expect(ended).toEqual({
      kind: 'end-capture',
      captureId: begun?.kind === 'capture-chrome' ? begun.captureId : 'missing'
    })
    expect(capturePage).toHaveBeenCalledWith(
      { x: 0, y: 876, width: 800, height: 24 },
      { stayHidden: true }
    )
    expect(shot).toMatchObject({
      region: 'status-bar',
      width: 800,
      height: 24,
      colorScheme: 'dark',
      themeApplied: true,
      errors: ['status item threw']
    })
  })

  it("refuses a plugin that isn't running, and passes the renderer's refusal on", async () => {
    const { contents } = window()
    await expect(
      shootPluginChrome(deps('pending'), contents, { pluginKey: KEY, region: 'window' })
    ).rejects.toThrow(/waiting for approval/)
    relay.requestPluginViewFromRenderer.mockImplementation(
      answer({ requestId: 'r', ok: false, code: 'chrome_hidden', message: 'status bar is hidden' })
    )
    await expect(
      shootPluginChrome(deps(), contents, { pluginKey: KEY, region: 'status-bar' })
    ).rejects.toMatchObject({ message: 'status bar is hidden' })
    // The theme is put back even then.
    expect(relay.requestPluginViewFromRenderer.mock.calls.at(-1)?.[1]).toEqual({
      kind: 'end-capture',
      captureId: expect.any(String)
    })
  })
})
