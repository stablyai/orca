import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

import type { SshTarget } from '../../../shared/ssh-types'
import {
  disallowDesktopBrowserBridgeHost,
  type DesktopBrowserBridgeHostControlDeps
} from './desktop-browser-bridge-host-control'
import {
  isDesktopBrowserBridgeHostStopped,
  setDesktopBrowserBridgeControl,
  setDesktopBrowserBridgeHostStopped
} from './desktop-browser-bridge-reconcile'

function setup(targets: SshTarget[] = []) {
  let noticed: string[] | undefined
  const byId = new Map(targets.map((target) => [target.id, target]))
  const sent: { channel: string; payload: unknown }[] = []
  const window = {
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload })
    }
  }
  const deps: DesktopBrowserBridgeHostControlDeps = {
    settings: {
      getSettings: () => ({ desktopBrowserBridgeNoticedTargetIds: noticed }),
      updateSettings: (updates) => {
        noticed = updates.desktopBrowserBridgeNoticedTargetIds
      }
    },
    targets: {
      getTarget: (id) => byId.get(id),
      updateTarget: vi.fn((id: string, updates: Partial<SshTarget>) => {
        const target = byId.get(id)
        if (target) {
          byId.set(id, { ...target, ...updates })
        }
      })
    },
    endHostActivity: vi.fn()
  }
  const reconcile = vi.fn()
  setDesktopBrowserBridgeControl({ reconcile, resetEnvironment: vi.fn() })
  return {
    deps,
    sent,
    reconcile,
    byId,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the notice reads only webContents.isDestroyed and send.
    mainWindow: () => window as unknown as Electron.BrowserWindow
  }
}

const userHost: SshTarget = { id: 'ssh-1', label: 'build-box', host: 'h', port: 22, username: 'u' }
const orcaOwnedHost: SshTarget = {
  id: 'runtime-ssh-1',
  label: 'sandbox',
  host: 'h',
  port: 22,
  username: 'u',
  owner: { type: 'on-demand-runtime', runtimeId: 'r1' }
}

describe('desktop browser bridge host control', () => {
  afterEach(() => {
    setDesktopBrowserBridgeHostStopped(userHost.id, false)
    setDesktopBrowserBridgeHostStopped(orcaOwnedHost.id, false)
    setDesktopBrowserBridgeControl(null)
  })

  it("Don't allow turns the host's setting off, and only stops hosts Orca created", () => {
    const { deps, byId } = setup([userHost, orcaOwnedHost])

    expect(disallowDesktopBrowserBridgeHost(userHost.id, deps)).toBe(true)
    expect(byId.get(userHost.id)?.allowRemoteCliControl).toBe(false)
    expect(isDesktopBrowserBridgeHostStopped(userHost.id)).toBe(true)

    expect(disallowDesktopBrowserBridgeHost(orcaOwnedHost.id, deps)).toBe(false)
    expect(byId.get(orcaOwnedHost.id)?.allowRemoteCliControl).toBeUndefined()
    expect(isDesktopBrowserBridgeHostStopped(orcaOwnedHost.id)).toBe(true)
  })
})
