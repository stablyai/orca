import { describe, expect, it } from 'vitest'
import {
  isTerminalCoveredByNativeChat,
  mobileNativeChatSubscribeViewport,
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
    expect(isTerminalCoveredByNativeChat(true, 'pty-1', 'pty-2')).toBe(false)
    expect(isTerminalCoveredByNativeChat(false, 'pty-1', 'pty-1')).toBe(false)
    expect(isTerminalCoveredByNativeChat(true, null, 'pty-1')).toBe(false)
  })

  it('omits the viewport from a covered lease subscribe so the host keeps desktop dims', () => {
    // Even a lease-only subscribe phone-fits the PTY if it carries a viewport.
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
    // The covered stream owns the composer’s input lease; no other path re-subscribes it.
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
    // Tab switching may subscribe before the route uncovers the terminal, leaving a lease without output.
    expect(resolveMobileNativeChatTerminalStreamAction({ ...base, streamIsLeaseOnly: true })).toBe(
      'resume'
    )
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        streamIsLeaseOnly: true,
        webViewReady: false
      })
    ).toBe('none')
  })

  it('leaves a lease-only stream alone while chat still covers it (#10681)', () => {
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
    expect(
      resolveMobileNativeChatTerminalStreamAction({
        ...base,
        streamCovered: true,
        webViewReady: false
      })
    ).toBe('none')
  })
})
