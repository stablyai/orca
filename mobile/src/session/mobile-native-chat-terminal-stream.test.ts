import { describe, expect, it } from 'vitest'
import {
  isTerminalCoveredByNativeChat,
  mobileNativeChatSubscribeViewport,
  mobileNativeChatTerminalCapabilities,
  resolveMobileNativeChatTerminalStreamAction
} from './mobile-native-chat-terminal-stream'

const base = {
  showNativeChat: false,
  activeHandle: 'pty-1',
  activeTabType: 'terminal',
  streamActive: true,
  streamCovered: false,
  webViewReady: true
}

describe('mobile native-chat terminal stream lifecycle', () => {
  it('pauses an active terminal stream while chat covers it', () => {
    expect(resolveMobileNativeChatTerminalStreamAction({ ...base, showNativeChat: true })).toBe(
      'pause'
    )
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        showNativeChat: true,
        streamActive: false
      })
    ).toBe('pause')
    expect(isTerminalCoveredByNativeChat(true, 'pty-1', 'pty-1')).toBe(true)
    expect(mobileNativeChatTerminalCapabilities(true)).toEqual({
      terminalBinaryStream: 1,
      mobileInputLeaseOnly: 1
    })
    expect(mobileNativeChatTerminalCapabilities(false)).toEqual({ terminalBinaryStream: 1 })
  })

  it('omits the viewport from a covered lease subscribe so the host keeps desktop dims', () => {
    // Why: handleMobileSubscribe phone-fits the PTY whenever a viewport is present,
    // even for a lease-only subscribe — entering chat must not resize the terminal.
    expect(mobileNativeChatSubscribeViewport(true, { cols: 40, rows: 60 })).toBeUndefined()
    expect(mobileNativeChatSubscribeViewport(false, { cols: 40, rows: 60 })).toEqual({
      cols: 40,
      rows: 60
    })
    expect(mobileNativeChatSubscribeViewport(false, null)).toBeUndefined()
  })

  it('records a cold-start cover before WebView readiness so return refreshes', () => {
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        showNativeChat: true,
        streamActive: false,
        webViewReady: false
      })
    ).toBe('pause')
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        streamActive: true,
        streamCovered: true
      })
    ).toBe('resume')
  })

  it('resumes only the ready active terminal after chat closes', () => {
    expect(resolveMobileNativeChatTerminalStreamAction({ ...base, streamActive: false })).toBe(
      'resume'
    )
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        streamActive: false,
        webViewReady: false
      })
    ).toBe('none')
    expect(resolveMobileNativeChatTerminalStreamAction({ ...base, streamCovered: true })).toBe(
      'resume'
    )
  })

  it('does nothing for non-terminal tabs, missing handles, or settled states', () => {
    expect(resolveMobileNativeChatTerminalStreamAction(base)).toBe('none')
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        showNativeChat: true,
        streamActive: false,
        streamCovered: true
      })
    ).toBe('none')
    expect(resolveMobileNativeChatTerminalStreamAction({ ...base, activeTabType: 'browser' })).toBe(
      'none'
    )
    expect(resolveMobileNativeChatTerminalStreamAction({ ...base, activeHandle: null })).toBe(
      'none'
    )
  })
})
