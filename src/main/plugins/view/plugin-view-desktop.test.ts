import type { NativeImage, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginViewReply,
  PluginViewRequestBody
} from '../../../shared/plugins/view/plugin-view-protocol'
import type { PluginHostListEntry } from '../../../shared/plugins/plugin-list-entry'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
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

const KEY = 'acme.todos'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these NativeImage members.
const CAPTURED = {
  isEmpty: () => false,
  getSize: () => ({ width: 300, height: 600 }),
  toPNG: () => Buffer.from('png')
} as unknown as NativeImage

function deps(overrides: Partial<PluginViewDesktopDeps> = {}): PluginViewDesktopDeps {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the view reads only these WebContents members.
  const contents = {
    isDestroyed: () => false,
    getBackgroundThrottling: () => false,
    setBackgroundThrottling: vi.fn(),
    getZoomFactor: () => 1,
    capturePage: vi.fn(async () => CAPTURED)
  } as unknown as WebContents
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only these members.
  const plugin = {
    pluginKey: KEY,
    rootDir: '/p',
    contentHash: 'sha256-0123456789abcdef',
    manifest: {
      contributes: {
        panels: [{ id: 'todos', title: 'Todos', entry: 'p.tsx', ui: 'components' }],
        customEditors: [{ id: 'notes', title: 'Notes', extensions: ['.notes'], filenames: [] }]
      }
    }
  } as unknown as ValidDiscoveredPlugin
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only pluginKey and status.
  const entry = { pluginKey: KEY, status: 'idle' } as PluginHostListEntry
  return {
    rendererContents: () => contents,
    source: { list: async () => [entry], findValidPlugin: (key) => (key === KEY ? plugin : null) },
    logsSince: (_key, cursor) =>
      cursor
        ? {
            lines: [
              { level: 'info', line: 'hello' },
              { level: 'error', line: '[frame] src/panel.tsx:3 boom' }
            ],
            cursor: 'n:9'
          }
        : { lines: [], cursor: 'n:5' },
    guestsOf: () => [],
    ...overrides
  }
}

beforeEach(() => relay.requestPluginViewFromRenderer.mockReset())

describe('plugins.open on the desktop', () => {
  it('asks the renderer to show the default panel', async () => {
    relay.requestPluginViewFromRenderer.mockResolvedValue({ requestId: 'r', ok: true })
    await expect(createPluginViewDesktop(deps()).open({ pluginKey: KEY })).resolves.toEqual({
      pluginKey: KEY,
      kind: 'panel',
      panelId: 'todos',
      title: 'Todos'
    })
    expect(relay.requestPluginViewFromRenderer.mock.calls[0]?.[1]).toEqual({
      kind: 'open-panel',
      pluginKey: KEY,
      panelId: 'todos'
    })
  })

  it('opens a file in the matching editor and passes renderer refusals on', async () => {
    relay.requestPluginViewFromRenderer.mockResolvedValue({
      requestId: 'r',
      ok: false,
      code: 'no_workspace',
      message: 'none is showing'
    })
    await expect(
      createPluginViewDesktop(deps()).open({ pluginKey: KEY, filePath: '/w/a.notes' })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'none is showing',
      data: {
        reason: 'no_workspace',
        nextSteps: ['Open a workspace in Orca, then run this again.']
      }
    })
    expect(relay.requestPluginViewFromRenderer.mock.calls[0]?.[1]).toEqual({
      kind: 'open-editor',
      pluginKey: KEY,
      editorId: 'notes',
      filePath: '/w/a.notes'
    })
  })

  it('fails without a window', async () => {
    await expect(
      createPluginViewDesktop(deps({ rendererContents: () => null })).open({ pluginKey: KEY })
    ).rejects.toThrow(/no open window/)
  })
})

const DRAWN: PluginViewReply = {
  requestId: 'r',
  ok: true,
  panel: {
    rect: { x: 900, y: 40, width: 300, height: 600 },
    ui: 'components',
    guestUrl: null,
    issue: 'Panel failed to load',
    colorScheme: 'light',
    themeApplied: true,
    settled: true
  }
}

/** The renderer's answers: `openPanel` for the capture request, ok for the restore. */
function answer(openPanel: PluginViewReply) {
  // Why optional: bun's mock runner may probe the implementation with no arguments.
  return async (...args: [unknown?, PluginViewRequestBody?, number?]): Promise<PluginViewReply> =>
    args[1]?.kind === 'open-panel' ? openPanel : { requestId: 'r', ok: true }
}

describe('plugins.shot on the desktop', () => {
  it('waits for the current revision, captures its rect, reports errors, then restores', async () => {
    relay.requestPluginViewFromRenderer.mockImplementation(answer(DRAWN))
    const shot = await createPluginViewDesktop(deps()).shot({
      pluginKey: KEY,
      colorScheme: 'light',
      width: 300
    })
    expect(shot).toMatchObject({
      panelId: 'todos',
      width: 300,
      height: 600,
      colorScheme: 'light',
      themeApplied: true,
      png: Buffer.from('png').toString('base64'),
      errors: ['Panel failed to load', '[frame] src/panel.tsx:3 boom']
    })
    const bodies = relay.requestPluginViewFromRenderer.mock.calls.map((call) => call[1])
    expect(bodies).toEqual([
      {
        kind: 'open-panel',
        pluginKey: KEY,
        panelId: 'todos',
        capture: {
          guestRevision: 'sha256-012345678',
          width: 300,
          colorScheme: 'light',
          timeoutMs: 15_000
        }
      },
      { kind: 'end-capture' }
    ])
  })

  it('restores the capture overrides when the renderer cannot show the panel', async () => {
    relay.requestPluginViewFromRenderer.mockImplementation(
      answer({ requestId: 'r', ok: false, code: 'panel_failed', message: 'stopped responding' })
    )
    await expect(createPluginViewDesktop(deps()).shot({ pluginKey: KEY })).rejects.toThrow(
      'stopped responding'
    )
    expect(relay.requestPluginViewFromRenderer.mock.calls.at(-1)?.[1]).toEqual({
      kind: 'end-capture'
    })
  })
})
