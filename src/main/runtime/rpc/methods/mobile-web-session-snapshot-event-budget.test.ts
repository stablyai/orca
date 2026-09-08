/**
 * Two limits govern one snapshot. `MOBILE_WEB_SESSION_TAB_LIMIT` degrades: it slices to 200, keeps
 * the active tab, and reports `truncated`. `MOBILE_WEB_SESSION_EVENT_MAX_BYTES` used to kill the
 * subscription instead, and a browser tab at the schema maximum serializes to roughly 5 KB, so a
 * user with ~40 long-URL tabs crossed the byte cap long before the count cap and the page hung on
 * "Loading tabs" forever. The byte cap now degrades the same way.
 */
import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_SESSION_EVENT_MAX_BYTES } from '../../../../shared/mobile-web/bridge-operation-contract'
import { mobileWebSessionSnapshot } from './mobile-web-session-snapshot'

const HOST_WORKSPACE = 'workspace-1'
const PAGE_WORKSPACE = 'opaque-workspace'

function browserPageId(index: number): string {
  return `page-${index}`.padEnd(512, 'x')
}

function oversizeBrowserTabs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'browser',
    id: browserPageId(index),
    browserPageId: browserPageId(index),
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
    activeTabId: browserPageId(3),
    activeTabType: 'browser',
    tabs: oversizeBrowserTabs(count)
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
    const snapshot = mobileWebSessionSnapshot(hostSnapshot(40), HOST_WORKSPACE, PAGE_WORKSPACE)

    expect(encodedByteLength(snapshot)).toBeLessThanOrEqual(MOBILE_WEB_SESSION_EVENT_MAX_BYTES)
    expect(snapshot.tabs.length).toBeGreaterThan(0)
    expect(snapshot.tabs.length).toBeLessThan(40)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.tabs.some((tab) => tab.isActive)).toBe(true)
    expect(snapshot.activeTabId).toBe(snapshot.tabs.find((tab) => tab.isActive)?.id)
  })

  it('leaves a snapshot that already fits untouched', () => {
    const snapshot = mobileWebSessionSnapshot(hostSnapshot(3), HOST_WORKSPACE, PAGE_WORKSPACE)

    expect(snapshot.tabs).toHaveLength(3)
    expect(snapshot.truncated).toBe(false)
  })
})
