import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeImage, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginViewReply,
  PluginViewRequestBody
} from '../../../shared/plugins/view/plugin-view-protocol'
import type { PluginHostListEntry } from '../../../shared/plugins/plugin-list-entry'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginViewDesktopDeps } from './plugin-view-desktop'
import { pluginEditorFileTarget, shootPluginEditor } from './plugin-view-editor-shot'

const relay = vi.hoisted(() => ({
  requestPluginViewFromRenderer:
    vi.fn<(contents: unknown, body: PluginViewRequestBody) => Promise<PluginViewReply>>()
}))
vi.mock('./plugin-view-renderer-relay', () => relay)

const KEY = 'acme.sketch'
const GUEST_URL = 'orca-plugin-frame://sketch/editor.html?rev=1'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these NativeImage members.
const CAPTURED = {
  isEmpty: () => false,
  getSize: () => ({ width: 400, height: 300 }),
  toBitmap: () => Buffer.alloc(400 * 300 * 4, 7),
  toPNG: () => Buffer.from('png')
} as unknown as NativeImage

function fakeContents(url = '') {
  const sent: unknown[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shot reads only these WebContents members.
  const contents = {
    isDestroyed: () => false,
    getURL: () => url,
    getBackgroundThrottling: () => false,
    setBackgroundThrottling: vi.fn(),
    getZoomFactor: () => 1,
    capturePage: vi.fn(async () => CAPTURED),
    executeJavaScript: vi.fn(async () => true),
    sendInputEvent: (event: unknown) => sent.push(event)
  } as unknown as WebContents
  return { contents, sent }
}

function deps(guest: WebContents, errors: string[] = []): PluginViewDesktopDeps {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only these members.
  const plugin = {
    pluginKey: KEY,
    manifest: {
      contributes: {
        panels: [],
        customEditors: [{ id: 'sketch', title: 'Sketch', extensions: ['.sketch'], filenames: [] }]
      }
    }
  } as unknown as ValidDiscoveredPlugin
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only pluginKey and status.
  const entry = { pluginKey: KEY, status: 'idle' } as PluginHostListEntry
  return {
    rendererContents: () => null,
    windowShown: () => false,
    source: { list: async () => [entry], findValidPlugin: () => plugin },
    logsSince: (_key, cursor) => ({
      lines: cursor ? errors.map((line) => ({ level: 'error', line })) : [],
      cursor: 'n:1'
    }),
    guestsOf: () => [guest],
    imageFromBitmap: vi.fn(() => CAPTURED)
  }
}

function drawn(subscribed: boolean, issue: string | null = null): PluginViewReply {
  return {
    requestId: 'r',
    ok: true,
    panel: {
      rect: { x: 100, y: 40, width: 400, height: 300 },
      guestRect: { x: 100, y: 40, width: 400, height: 300 },
      ui: 'html',
      guestUrl: GUEST_URL,
      issue,
      colorScheme: 'light',
      themeApplied: true,
      settled: true,
      subscribed
    }
  }
}

// Why optional: bun's mock runner may probe the implementation with no arguments.
const answer =
  (reply: PluginViewReply) =>
  async (...args: [unknown?, PluginViewRequestBody?]): Promise<PluginViewReply> =>
    args[1]?.kind === 'open-editor' ? reply : { requestId: 'r', ok: true }

beforeEach(() => relay.requestPluginViewFromRenderer.mockReset())

describe('shot --editor', () => {
  it('opens the file for capture, sends acts to the guest in its own pixels, then puts the theme back', async () => {
    const guest = fakeContents(GUEST_URL)
    relay.requestPluginViewFromRenderer.mockImplementation(answer(drawn(true)))
    const shot = await shootPluginEditor(deps(guest.contents), fakeContents().contents, {
      pluginKey: KEY,
      filePath: '/w/a.sketch',
      colorScheme: 'light',
      width: 400,
      acts: [{ click: [10, 20] }]
    })
    expect(shot).toMatchObject({ editorId: 'sketch', subscribed: true, errors: [], acted: 1 })
    expect(relay.requestPluginViewFromRenderer.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        kind: 'open-editor',
        editorId: 'sketch',
        fallbackFolder: '/w',
        capture: expect.objectContaining({ colorScheme: 'light', width: 400 })
      }),
      { kind: 'end-capture' }
    ])
    expect(guest.sent).toContainEqual({
      type: 'mouseDown',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1
    })
  })

  it('reports a frame that never asked for its document and the errors it logged', async () => {
    relay.requestPluginViewFromRenderer.mockImplementation(answer(drawn(false, 'never asked')))
    const guest = fakeContents(GUEST_URL)
    const shot = await shootPluginEditor(
      deps(guest.contents, ["[frame] Refused to load the script 'https://cdn.example'"]),
      fakeContents().contents,
      { pluginKey: KEY, filePath: '/w/a.sketch' }
    )
    expect(shot.subscribed).toBe(false)
    expect(shot.errors).toEqual([
      'never asked',
      "[frame] Refused to load the script 'https://cdn.example'"
    ])
  })

  it('refuses acts while the window is on screen', async () => {
    const guest = fakeContents(GUEST_URL)
    await expect(
      shootPluginEditor(
        { ...deps(guest.contents), windowShown: () => true },
        fakeContents().contents,
        { pluginKey: KEY, filePath: '/w/a.sketch', acts: [{ key: 'r' }] }
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(relay.requestPluginViewFromRenderer).not.toHaveBeenCalled()
  })
})

describe('the file target', () => {
  it('names the real path too, so a symlinked folder still finds its workspace', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-editor-target-')))
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 'a.sketch'), '{}')
    symlinkSync(join(root, 'real'), join(root, 'link'))
    await expect(pluginEditorFileTarget(join(root, 'link', 'a.sketch'))).resolves.toEqual({
      filePathAliases: [join(root, 'real', 'a.sketch')],
      fallbackFolder: join(root, 'real')
    })
    await expect(pluginEditorFileTarget(join(root, 'missing.sketch'))).resolves.toEqual({
      fallbackFolder: root
    })
  })
})
