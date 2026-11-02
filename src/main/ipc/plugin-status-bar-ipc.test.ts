import { describe, expect, it, vi } from 'vitest'

const send = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] }
}))

import { registerPluginStatusBarHandlers } from './plugin-status-bar-ipc'
import type { PluginService } from '../plugins/plugin-service'
import {
  PluginStatusBarState,
  pluginStatusBarRevision
} from '../plugins/status-bar/plugin-status-bar-state'

type Install = { rootDir: string; manifest: { version: string } }

function setup() {
  const statusBar = new PluginStatusBarState()
  const installs = new Map<string, Install>([
    ['acme.guard', { rootDir: '/p/guard', manifest: { version: '1.0.0' } }],
    ['acme.other', { rootDir: '/p/other', manifest: { version: '1.0.0' } }]
  ])
  let changed: () => void = () => {}
  const service = {
    options: { statusBar },
    findApprovedPlugin: (key: string) => installs.get(key) ?? null,
    onChanged: (listener: () => void) => {
      changed = listener
      return () => {}
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only options, findApprovedPlugin and onChanged.
  registerPluginStatusBarHandlers(service as unknown as PluginService)
  const set = (key: string, text: string) => {
    const install = installs.get(key)
    statusBar.update(key, install ? pluginStatusBarRevision(install) : '', 'item', { text })
  }
  return { statusBar, installs, set, changed: () => changed() }
}

describe('plugin status bar changes', () => {
  it('pushes every change to the windows', () => {
    const { set } = setup()
    set('acme.guard', '1 blocked')
    expect(send).toHaveBeenLastCalledWith('plugins:statusBarChanged', {
      'acme.guard': { item: { text: '1 blocked' } }
    })
  })

  it('starts a disabled, removed or updated plugin over from its manifest values', () => {
    const { statusBar, installs, set, changed } = setup()
    set('acme.guard', '1 blocked')
    set('acme.other', 'kept')
    changed()
    expect(Object.keys(statusBar.snapshot())).toEqual(['acme.guard', 'acme.other'])

    installs.set('acme.guard', { rootDir: '/p/guard', manifest: { version: '1.1.0' } })
    changed()
    expect(statusBar.snapshot()).toEqual({ 'acme.other': { item: { text: 'kept' } } })

    installs.delete('acme.other')
    changed()
    expect(statusBar.snapshot()).toEqual({})
  })

  it('drops older changes when a new install writes first', () => {
    const { statusBar, installs, set } = setup()
    set('acme.guard', 'old')
    statusBar.update(
      'acme.guard',
      pluginStatusBarRevision({ rootDir: '/p/guard', manifest: { version: '1.0.0' } }),
      'b',
      {
        tone: 'danger'
      }
    )
    installs.set('acme.guard', { rootDir: '/p/guard2', manifest: { version: '2.0.0' } })
    set('acme.guard', 'new')
    expect(statusBar.snapshot()).toEqual({ 'acme.guard': { item: { text: 'new' } } })
  })
})
