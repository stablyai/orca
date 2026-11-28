import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KeybindingFileSnapshot } from '../../shared/keybindings/types'
import { pluginManifestSchema } from '../../shared/plugins/manifest/plugin-manifest'
import type { ValidDiscoveredPlugin } from '../plugins/discovery/plugin-discovery'
import { PluginCommandRegistry } from '../plugins/commands/plugin-command-registry'
import { KeybindingService } from '../keybindings/keybinding-service'
import { registerKeybindingHandlers } from './keybindings'
import type { IpcHandleListener } from './lazy-ipc-handle-group'
import type { IpcMainInvokeEvent } from 'electron'

const electron = vi.hoisted(() => {
  const windows: {
    send: ReturnType<typeof vi.fn<(channel: string, snapshot: KeybindingFileSnapshot) => void>>
  }[] = []
  return {
    windows,
    openPath: vi.fn<(path: string) => Promise<string>>(),
    showItemInFolder: vi.fn<(path: string) => void>()
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: electron.openPath, showItemInFolder: electron.showItemInFolder },
  BrowserWindow: {
    getAllWindows: () =>
      electron.windows.map((window) => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: window.send }
      }))
  }
}))
vi.mock('../browser/guest-lifecycle/input/shortcuts/browser-guest-grab-shortcuts', () => ({
  refreshGrabShortcutPolicies: vi.fn()
}))
vi.mock('../menu/register-app-menu', () => ({ rebuildAppMenu: vi.fn() }))

function plugin(id: string, action: string): ValidDiscoveredPlugin {
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id,
    publisher: 'samples',
    name: id,
    version: '1.0.0',
    engines: { orca: '>=1.4.160' },
    pluginApi: 1,
    capabilities: [],
    contributes: {
      commands: [{ id: 'cmd', title: id, action }],
      keybindings: [{ command: 'cmd', key: 'Mod+Alt+K' }]
    }
  })
  return {
    pluginKey: `samples.${id}`,
    rootDir: `/plugins/samples.${id}`,
    manifest,
    consentFingerprint: id,
    contentHash: id,
    isDev: false
  }
}

// An inert floating alias and an unrelated plugin share a chord; they clash only once active.
const ALIAS = plugin('maximizer', 'floatingWorkspace.maximize')
const UNRELATED = plugin('sidebar', 'sidebar.left.toggle')

let homePath = ''

function setup() {
  electron.windows.splice(0, electron.windows.length, { send: vi.fn() }, { send: vi.fn() })
  // Settings are on, but an enabling reload failed: main committed the fail-closed snapshot.
  const service = new KeybindingService({
    homePath,
    platform: 'darwin',
    getFloatingWorkspaceShortcutsActive: () => true
  })
  service.publishInactiveFloatingWorkspaceFallback()
  const registry = new PluginCommandRegistry()
  const onChanged = vi.fn(() =>
    registry.reconcile(
      [ALIAS, UNRELATED],
      () => true,
      service.getOverrides(),
      'darwin',
      service.committedFloatingWorkspaceShortcutsActive()
    )
  )
  onChanged()
  expect(registry.error(UNRELATED.pluginKey)).toBeNull()
  onChanged.mockClear()
  const handlers = new Map<string, IpcHandleListener>()
  registerKeybindingHandlers(service, onChanged, {
    handle: (channel, listener) => handlers.set(channel, listener)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the open and reveal handlers never read the invoke event.
  const invoke = (channel: string) => handlers.get(channel)?.({} as IpcMainInvokeEvent)
  const broadcasts = () => electron.windows.map((window) => window.send.mock.calls.at(-1)?.[1])
  return { registry, onChanged, invoke, broadcasts }
}

describe('opening or revealing keybindings publishes the committed snapshot', () => {
  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), 'orca-keybindings-publish-'))
    electron.openPath.mockReset()
    electron.showItemInFolder.mockReset()
  })

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true })
  })

  it('reaches every window and reconciles plugins before a failing open', async () => {
    const h = setup()
    let finishOpen!: (error: string) => void
    electron.openPath.mockImplementation(
      () => new Promise<string>((resolve) => (finishOpen = resolve))
    )
    const opening = Promise.resolve(h.invoke('keybindings:openFile'))
    // Published while the OS open is still pending.
    expect(h.broadcasts().map((snapshot) => snapshot?.floatingWorkspaceShortcutsActive)).toEqual([
      true,
      true
    ])
    expect(h.onChanged).toHaveBeenCalledTimes(1)
    expect(h.registry.error(UNRELATED.pluginKey)).toMatch(/conflicts with another plugin/)
    finishOpen('No application knows how to open this file')
    await expect(opening).rejects.toThrow(/No application/)
    const [first, second] = h.broadcasts()
    expect(second).toBe(first)
  })

  it('reaches every window and reconciles plugins when revealing', () => {
    const h = setup()
    const returned = h.invoke('keybindings:revealFile')
    const [revealed, second] = h.broadcasts()
    expect(second).toBe(revealed)
    expect(returned).toBe(revealed)
    expect(revealed?.floatingWorkspaceShortcutsActive).toBe(true)
    expect(h.onChanged).toHaveBeenCalledTimes(1)
    expect(h.registry.error(UNRELATED.pluginKey)).toMatch(/conflicts with another plugin/)
    expect(electron.showItemInFolder).toHaveBeenCalledWith(revealed?.path)
    expect(electron.windows[0]?.send.mock.invocationCallOrder[0]).toBeLessThan(
      electron.showItemInFolder.mock.invocationCallOrder[0] ?? 0
    )
  })
})
