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
  // A drawn panel: more than a background and a border.
  toBitmap: () => Buffer.from([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]),
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
    windowShown: () => false,
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
    imageFromBitmap: vi.fn(),
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

  it('captures in the current theme while the window is on screen, without repainting', async () => {
    relay.requestPluginViewFromRenderer.mockImplementation(
      answer({ ...DRAWN, panel: { ...DRAWN.panel!, colorScheme: 'dark', themeApplied: false } })
    )
    const shot = await createPluginViewDesktop(deps({ windowShown: () => true })).shot({
      pluginKey: KEY,
      colorScheme: 'light'
    })
    expect(shot).toMatchObject({
      colorScheme: 'dark',
      themeApplied: false,
      themeReason:
        'the Orca window is visible; capturing in the current theme so the app is not repainted'
    })
    const capture = relay.requestPluginViewFromRenderer.mock.calls[0]?.[1]
    expect(capture).toMatchObject({ kind: 'open-panel' })
    expect(capture?.kind === 'open-panel' && capture.capture?.colorScheme).toBeUndefined()
  })

  it('answers not shown for ifShown instead of failing, and asks the renderer not to switch', async () => {
    relay.requestPluginViewFromRenderer.mockImplementation(
      answer({
        requestId: 'r',
        ok: false,
        code: 'not_shown',
        message: 'the right sidebar is closed'
      })
    )
    await expect(
      createPluginViewDesktop(deps()).shot({ pluginKey: KEY, ifShown: true })
    ).resolves.toEqual({
      pluginKey: KEY,
      panelId: 'todos',
      title: 'Todos',
      notShown: 'the right sidebar is closed'
    })
    expect(relay.requestPluginViewFromRenderer.mock.calls[0]?.[1]).toMatchObject({
      capture: { ifShown: true }
    })
    // Without ifShown the same reply is an error.
    await expect(createPluginViewDesktop(deps()).shot({ pluginKey: KEY })).rejects.toThrow(
      'the right sidebar is closed'
    )
  })

  it('passes --act through and returns its results; refuses on screen and for html', async () => {
    const acts = [{ press: { text: 'Add' } }]
    relay.requestPluginViewFromRenderer.mockImplementation(
      answer({ ...DRAWN, panel: { ...DRAWN.panel!, actions: [{ ok: true }] } })
    )
    const shot = await createPluginViewDesktop(deps()).shot({ pluginKey: KEY, acts })
    expect(shot).toMatchObject({ actions: [{ ok: true }], restored: false })
    const [, body, timeoutMs] = relay.requestPluginViewFromRenderer.mock.calls[0] ?? []
    expect(body).toMatchObject({ capture: { acts } })
    expect(timeoutMs).toBe(27_500)

    relay.requestPluginViewFromRenderer.mockClear()
    await expect(
      createPluginViewDesktop(deps({ windowShown: () => true })).shot({ pluginKey: KEY, acts })
    ).rejects.toMatchObject({
      message:
        "shot --act needs Orca's window hidden or minimized, so it never clicks under the user",
      data: { reason: 'window_shown' }
    })
    expect(relay.requestPluginViewFromRenderer).not.toHaveBeenCalled()
  })

  it('reports unanswered host calls and whether --act was put back once the capture ended', async () => {
    relay.requestPluginViewFromRenderer.mockImplementation(async (...args) =>
      args[1]?.kind === 'open-panel'
        ? { ...DRAWN, panel: { ...DRAWN.panel!, pendingRequests: 1, actions: [{ ok: true }] } }
        : { requestId: 'r', ok: true, restored: true }
    )
    const view = createPluginViewDesktop(deps())
    await expect(
      view.shot({ pluginKey: KEY, acts: [{ toggle: { label: 'Hide done' } }] })
    ).resolves.toMatchObject({ pendingRequests: 1, restored: true })
    // Without acts there is nothing to put back, so no `restored`.
    expect(await view.shot({ pluginKey: KEY })).not.toHaveProperty('restored')
  })
})
