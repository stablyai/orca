import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  attachGuestPolicies: vi.fn(),
  installNavigationPolicy: vi.fn(),
  isAllowedPartition: vi.fn(),
  attachRouteGuest: vi.fn(),
  registerPluginGuard: vi.fn()
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: { attachGuestPolicies: mocks.attachGuestPolicies }
}))
vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { isAllowedPartition: mocks.isAllowedPartition }
}))
vi.mock('../plugins/plugin-panel-navigation-guard', () => ({
  registerPluginPanelNavigationGuard: mocks.registerPluginGuard
}))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: mocks.installNavigationPolicy
}))
vi.mock('../browser/browser-route-session-runtime', () => ({
  browserRouteSessionRegistry: { isAllowedPartition: () => false },
  browserRouteWebContentsRegistry: { attachGuest: mocks.attachRouteGuest }
}))
vi.mock('../browser/local-ssh-browser-partitions', () => ({
  isLocalSshBrowserPartition: () => false,
  enforceLocalSshWebRtcPolicyForGuest: vi.fn()
}))
vi.mock('../browser/doc-preview-protocol', () => ({
  isDocPreviewSession: () => false
}))

import { installFloatingWorkspaceWebviewSecurity } from './main-window-webview-security'
import { getDocPreviewGrant, mintDocPreviewGrant } from '../browser/doc-preview-grant-registry'

describe('installFloatingWorkspaceWebviewSecurity', () => {
  function installOnFakeChildWindow() {
    const handlers: Record<string, (...args: never[]) => void> = {}
    const webContents = {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers[event] = handler
      })
    }
    installFloatingWorkspaceWebviewSecurity({ webContents } as never)
    return { handlers, webContents }
  }

  it('installs navigation and plugin guards on the child window', () => {
    const { webContents } = installOnFakeChildWindow()
    expect(mocks.installNavigationPolicy).toHaveBeenCalledWith(webContents)
    expect(mocks.registerPluginGuard).toHaveBeenCalledWith(webContents)
  })

  it('attaches guest policies on did-attach-webview', () => {
    const { handlers } = installOnFakeChildWindow()
    const fakeGuest = { session: 'normal-session' }
    handlers['did-attach-webview']?.(undefined as never, fakeGuest as never)
    expect(mocks.attachGuestPolicies).toHaveBeenCalledWith(fakeGuest)
    expect(mocks.attachRouteGuest).toHaveBeenCalledWith(fakeGuest)
  })

  it('does not clear doc preview grants on startup', () => {
    const grant = mintDocPreviewGrant({
      owner: { kind: 'ssh', connectionId: 'ssh-1' },
      root: '/home/alice/docs',
      entryRelativePath: 'index.html',
      browserPageId: 'page-1'
    })
    installOnFakeChildWindow()
    expect(getDocPreviewGrant(grant.id)).not.toBeNull()
  })
})
