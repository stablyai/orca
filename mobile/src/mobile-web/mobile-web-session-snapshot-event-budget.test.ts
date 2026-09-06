/**
 * Two limits govern one snapshot. `MOBILE_WEB_SESSION_TAB_LIMIT` degrades: it slices to 200, keeps
 * the active tab, and reports `truncated`. `MOBILE_WEB_SESSION_EVENT_MAX_BYTES` used to kill the
 * subscription instead, and a browser tab at the schema maximum serializes to roughly 5 KB, so a
 * user with ~40 long-URL tabs crossed the byte cap long before the count cap and the page hung on
 * "Loading tabs" forever. The byte cap now degrades the same way.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_SESSION_EVENT_MAX_BYTES,
  type MobileWebSessionSnapshotResult
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { mobileWebSessionSnapshot } from './mobile-web-session-snapshot'
import { MobileWebSessionSubscriptions } from './mobile-web-session-subscriptions'
import type { RpcClient } from '../transport/rpc-client'

const HOST_WORKSPACE = 'workspace-1'
const PAGE_WORKSPACE = 'opaque-workspace'

function oversizeBrowserTabs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'browser',
    id: `page-${index}`.padEnd(512, 'x'),
    browserPageId: `page-${index}`,
    title: `Tab ${index}`.padEnd(240, 'y'),
    url: `https://example.invalid/${index}/${'q'.repeat(4000)}`,
    isActive: index === 3,
    loading: false,
    canGoBack: true,
    canGoForward: false
  }))
}

function hostSnapshot(count: number) {
  return {
    worktree: HOST_WORKSPACE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 3,
    activeTabId: 'page-3',
    activeTabType: 'browser',
    tabs: oversizeBrowserTabs(count)
  }
}

function authorities() {
  return {
    browser: new MobileWebBrowserAuthority((length) => new Uint8Array(length)),
    nativeChat: new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
  }
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

describe('mobile web session snapshot event budget', () => {
  it('is reachable: 40 maximum-size browser tabs exceed the cap well under the tab limit', () => {
    expect(encodedByteLength(hostSnapshot(40).tabs)).toBeGreaterThan(
      MOBILE_WEB_SESSION_EVENT_MAX_BYTES
    )
  })

  it('trims to fit, keeps the active tab, and reports truncated', () => {
    const authority = authorities()
    const snapshot = mobileWebSessionSnapshot(
      hostSnapshot(40),
      HOST_WORKSPACE,
      PAGE_WORKSPACE,
      authority.browser,
      authority.nativeChat
    )

    expect(encodedByteLength(snapshot)).toBeLessThanOrEqual(MOBILE_WEB_SESSION_EVENT_MAX_BYTES)
    expect(snapshot.tabs.length).toBeGreaterThan(0)
    expect(snapshot.tabs.length).toBeLessThan(40)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.tabs.some((tab) => tab.isActive)).toBe(true)
    expect(snapshot.activeTabId).toBe(snapshot.tabs.find((tab) => tab.isActive)?.id)
  })

  it('leaves a snapshot that already fits untouched', () => {
    const authority = authorities()
    const snapshot = mobileWebSessionSnapshot(
      hostSnapshot(3),
      HOST_WORKSPACE,
      PAGE_WORKSPACE,
      authority.browser,
      authority.nativeChat
    )

    expect(snapshot.tabs).toHaveLength(3)
    expect(snapshot.truncated).toBe(false)
  })

  it('delivers the oversize snapshot to the page instead of silently dropping the subscription', async () => {
    const authority = authorities()
    const unsubscribe = vi.fn()
    let emit: ((event: unknown) => void) | null = null
    const client = {
      subscribe: (_method: string, _params: unknown, onEvent: (event: unknown) => void) => {
        emit = onEvent
        return unsubscribe
      }
    } as unknown as RpcClient
    const posted: MobileWebSessionSnapshotResult[] = []
    const subscriptions = new MobileWebSessionSubscriptions({
      isActive: () => true,
      browserAuthority: authority.browser,
      nativeChatAuthority: authority.nativeChat,
      postEvent: async (_subscriptionId, _sequence, snapshot) => {
        posted.push(snapshot)
      },
      postClosed: vi.fn()
    })

    subscriptions.start({
      requestId: 'R'.repeat(22),
      subscriptionId: 'S'.repeat(22),
      pageWorkspaceId: PAGE_WORKSPACE,
      hostWorkspaceId: HOST_WORKSPACE as never,
      client
    })
    emit?.(hostSnapshot(40))
    await Promise.resolve()
    await Promise.resolve()

    expect(posted).toHaveLength(1)
    expect(posted[0].truncated).toBe(true)
    expect(unsubscribe).not.toHaveBeenCalled()
    // The record is still live, so the page keeps receiving updates for this workspace.
    expect(subscriptions.countForOperation('session.subscribe')).toBe(1)
  })
})
