import { describe, expect, it } from 'vitest'
import { mobileWebShellInitMessage } from './mobile-web-shell-init-message'
import { parseMobileWebBridgeInitialMessage } from '../../../src/shared/mobile-web/bridge-contract'

describe('native shell resume init', () => {
  it('delivers opaque page state alongside a legacy route in the actual init envelope', () => {
    const pageState = JSON.stringify({ version: 99, route: 'future-settings' })
    const message = mobileWebShellInitMessage({
      shellSessionId: 'A'.repeat(43),
      buildId: 'a'.repeat(64),
      state: 'connected',
      hostDisplayName: 'Host',
      reconnectAttempts: 0,
      lastConnectedAt: null,
      resumeRoute: { kind: 'workspaceList' },
      pageState
    })
    expect(message.pageState).toBe(pageState)
    expect(parseMobileWebBridgeInitialMessage(JSON.stringify(message))).toMatchObject({
      ok: true,
      value: { pageState, resumeRoute: { kind: 'workspaceList' } }
    })
  })
})
