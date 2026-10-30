import { afterEach, describe, expect, it, vi } from 'vitest'

const { instances } = vi.hoisted(() => {
  const instances: { options: { webPreferences?: { additionalArguments?: string[] } } }[] = []
  return { instances }
})

vi.mock('electron', () => {
  class BrowserWindow {
    readonly webContents = {
      isDestroyed: () => false,
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    }
    constructor(readonly options: { webPreferences?: { additionalArguments?: string[] } }) {
      instances.push(this)
    }
    isDestroyed = () => false
    once = vi.fn()
    on = vi.fn()
    close = vi.fn()
    loadFile = vi.fn(async () => {})
    loadURL = vi.fn(async () => {})
  }
  return { app: { isPackaged: true }, BrowserWindow, nativeTheme: { shouldUseDarkColors: true } }
})
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: vi.fn()
}))
vi.mock('../ipc/ui', () => ({ sendToTrustedUIRenderer: vi.fn() }))

import { createOrFocusWorkspaceSpaceWindow } from './workspace-space-window'
import { hasWslHostsServeOnlyArgument } from '../../shared/wsl-host-internal-gate'
import { configureWslHostsGate, resetWslHostsGateForTests } from '../wsl/wsl-host-gate'

const store = {
  getUI: () => ({ uiZoomLevel: 0 }),
  onUIChanged: () => () => {}
}

afterEach(() => {
  vi.unstubAllEnvs()
  resetWslHostsGateForTests()
})

describe('Space window and the WSL hosts gate', () => {
  it('lets its preload expose saved WSL hosts in serve-only', () => {
    vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', undefined)
    configureWslHostsGate({ hasSavedWslHost: () => true, hasWslMoveCutover: () => false })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the window reads only getUI and onUIChanged from the store.
    createOrFocusWorkspaceSpaceWindow(store as never)

    expect(
      hasWslHostsServeOnlyArgument(instances[0].options.webPreferences?.additionalArguments ?? [])
    ).toBe(true)
  })
})
