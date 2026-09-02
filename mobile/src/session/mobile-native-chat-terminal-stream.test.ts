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
  streamIsLeaseOnly: false,
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

  it('rearms a covered stream that lost its subscription', () => {
    // The covered stream IS the input lease, and nothing else re-subscribes it —
    // losing it while chat is open must not leave the composer locked (#10681).
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        showNativeChat: true,
        streamActive: false,
        streamCovered: true
      })
    ).toBe('rearm')
  })

  it('resumes an uncovered handle still holding a lease-only stream', () => {
    // Leaving a chat tab for a terminal tab subscribes the incoming handle before the
    // route learns chat is gone, so the terminal streams nothing but its input lease.
    expect(resolveMobileNativeChatTerminalStreamAction({ ...base, streamIsLeaseOnly: true })).toBe(
      'resume'
    )
    // Same wait the other resume paths take — never init a WebView that cannot receive it.
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        streamIsLeaseOnly: true,
        webViewReady: false
      })
    ).toBe('none')
  })

  it('leaves a lease-only stream alone while chat still covers it (#10681)', () => {
    // Lease-only is the correct shape under chat; trading it for output here would
    // drop the input floor the composer depends on.
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        showNativeChat: true,
        streamCovered: true,
        streamIsLeaseOnly: true
      })
    ).toBe('none')
  })

  it('does nothing for non-terminal tabs, missing handles, or settled states', () => {
    // A full stream on an uncovered handle is the one genuinely settled shape.
    expect(resolveMobileNativeChatTerminalStreamAction({ ...base, streamIsLeaseOnly: false })).toBe(
      'none'
    )
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        showNativeChat: true,
        streamActive: true,
        streamCovered: true
      })
    ).toBe('none')
    expect(resolveMobileNativeChatTerminalStreamAction({ ...base, activeTabType: 'browser' })).toBe(
      'none'
    )
    expect(resolveMobileNativeChatTerminalStreamAction({ ...base, activeHandle: null })).toBe(
      'none'
    )
    // Leaving chat with the WebView not yet ready must wait, not resume blind.
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        streamCovered: true,
        webViewReady: false
      })
    ).toBe('none')
  })
})
