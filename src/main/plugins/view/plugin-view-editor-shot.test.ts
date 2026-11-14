import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { NativeImage, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginViewReply,
  PluginViewRequestBody
} from '../../../shared/plugins/view/plugin-view-protocol'
import type { PluginHostListEntry } from '../../../shared/plugins/plugin-list-entry'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import type { PluginViewDesktopDeps } from './plugin-view-desktop'
import { shootPluginEditor } from './plugin-view-editor-shot'

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

function fakeContents(url = '', id = 1) {
  const sent: unknown[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shot reads only these WebContents members.
  const contents = {
    id,
    isDestroyed: () => false,
    getURL: () => url,
    getBackgroundThrottling: () => false,
    setBackgroundThrottling: vi.fn(),
    getZoomFactor: () => 1,
    capturePage: vi.fn(async () => CAPTURED),
    executeJavaScript: vi.fn(async (script: string) => {
      sent.push({ script })
      return true
    }),
    sendInputEvent: (event: unknown) => sent.push(event)
  } as unknown as WebContents
  return { contents, sent }
}

function deps(
  guest: WebContents,
  errors: string[] = [],
  others: WebContents[] = []
): PluginViewDesktopDeps {
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
    guestsOf: () => [...others, guest],
    imageFromBitmap: vi.fn(() => CAPTURED)
  }
}

function drawn(
  subscribed: boolean,
  issue: string | null = null,
  guestContentsId?: number
): PluginViewReply {
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
      subscribed,
      ...(guestContentsId === undefined ? {} : { guestContentsId })
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
  it('acts on a temporary copy, never the file, and removes the copy afterwards', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-editor-shot-file-')))
    const file = join(root, 'a.sketch')
    writeFileSync(file, '{"shapes":[]}')
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orca-editor-shot-scratch-')))
    const guest = fakeContents(GUEST_URL)
    relay.requestPluginViewFromRenderer.mockImplementation(answer(drawn(true)))
    const shot = await shootPluginEditor(
      { ...deps(guest.contents), shotScratchRoot: () => scratch },
      fakeContents().contents,
      {
        pluginKey: KEY,
        filePath: file,
        colorScheme: 'light',
        width: 400,
        acts: [{ click: [10, 20] }]
      }
    )
    expect(shot).toMatchObject({ editorId: 'sketch', subscribed: true, acted: 1, copy: true })
    const [open, end] = relay.requestPluginViewFromRenderer.mock.calls.map((call) => call[1])
    expect(open).toMatchObject({
      kind: 'open-editor',
      capture: { scratch: true, colorScheme: 'light', width: 400 }
    })
    const copied = open?.kind === 'open-editor' ? open.filePath : ''
    expect(copied.startsWith(join(scratch, 'orca-editor-shot-'))).toBe(true)
    expect(basename(copied)).toBe('a.sketch')
    // Ends only this capture: a shot running beside it keeps its tab.
    expect(end).toEqual({
      kind: 'end-capture',
      captureId: open?.kind === 'open-editor' ? open.capture?.captureId : 'missing'
    })
    // The copy and its folder are gone, and the author's file was never opened for input.
    expect(readdirSync(scratch)).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe('{"shapes":[]}')
    expect(guest.sent).toContainEqual({
      type: 'mouseDown',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1
    })
  })
})
