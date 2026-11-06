import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

import type { SshTarget } from '../../../shared/ssh-types'
import {
  disallowDesktopBrowserBridgeHost,
  noticeDesktopBrowserBridgeHostControl,
  stopDesktopBrowserBridgeHost,
  type DesktopBrowserBridgeHostControlDeps
} from './desktop-browser-bridge-host-control'
import {
  isDesktopBrowserBridgeHostStopped,
  setDesktopBrowserBridgeControl,
  setDesktopBrowserBridgeHostStopped
} from './desktop-browser-bridge-reconcile'

const NOTICE_CHANNEL = 'browser:remoteHostControlNotice'

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

  it('tells the person once per host, and waits for a window before counting it shown', () => {
    const { deps, sent, mainWindow } = setup([userHost, orcaOwnedHost])
    const host = { targetId: userHost.id, hostLabel: 'build-box' }

    noticeDesktopBrowserBridgeHostControl(host, () => null, deps)
    expect(sent).toEqual([])

    noticeDesktopBrowserBridgeHostControl(host, mainWindow, deps)
    noticeDesktopBrowserBridgeHostControl(host, mainWindow, deps)
    noticeDesktopBrowserBridgeHostControl(
      { targetId: orcaOwnedHost.id, hostLabel: 'sandbox' },
      mainWindow,
      deps
    )

    expect(sent).toEqual([
      {
        channel: NOTICE_CHANNEL,
        payload: { targetId: 'ssh-1', hostLabel: 'build-box', canDisallow: true }
      },
      {
        channel: NOTICE_CHANNEL,
        payload: { targetId: 'runtime-ssh-1', hostLabel: 'sandbox', canDisallow: false }
      }
    ])
    expect(deps.settings?.getSettings().desktopBrowserBridgeNoticedTargetIds).toEqual([
      'ssh-1',
      'runtime-ssh-1'
    ])
  })

  it('Stop detaches the host and clears its tabs without touching its setting', () => {
    const { deps, reconcile, byId } = setup([userHost])

    stopDesktopBrowserBridgeHost(userHost.id, deps)

    expect(isDesktopBrowserBridgeHostStopped(userHost.id)).toBe(true)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(deps.endHostActivity).toHaveBeenCalledWith('ssh-1')
    expect(byId.get(userHost.id)?.allowRemoteCliControl).toBeUndefined()

    setDesktopBrowserBridgeHostStopped(userHost.id, false)
    expect(isDesktopBrowserBridgeHostStopped(userHost.id)).toBe(false)
    expect(reconcile).toHaveBeenCalledTimes(2)
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
