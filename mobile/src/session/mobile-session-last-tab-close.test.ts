import { describe, expect, it } from 'vitest'
import { readMobileSessionRouteSourceFamily } from './mobile-session-route-source-family.test-support'

const sessionRouteSource = readMobileSessionRouteSourceFamily()

describe('mobile session last-tab close', () => {
  it('preserves terminal identity while an empty snapshot may be transient', () => {
    const start = sessionRouteSource.indexOf('const applySessionTabs = useCallback')
    const end = sessionRouteSource.indexOf('const readMarkdownTab', start)
    const block = sessionRouteSource.slice(start, end)

    expect(block).toContain('} else if (active) {')
    expect(block).toContain('retainMissingSurfaces: result.tabs.length === 0')
  })

  it('clears stale active identity when closing leaves no tabs', () => {
    const start = sessionRouteSource.indexOf('async function handleCloseSessionTab')
    const end = sessionRouteSource.indexOf('const bulkCloseActions', start)
    const block = sessionRouteSource.slice(start, end)

    expect(block).toContain('remainingTabs.length === 0')
    expect(block).toContain('activeSessionTabIdRef.current = null')
    expect(block).toContain('activeHandleRef.current = null')
    expect(block).toContain(
      'reconcileBufferedDraftsRef.current(sessionTabsRef.current, remainingTabs)'
    )
  })

  it('ignores a pending terminal handle when the host requests follow navigation', () => {
    const start = sessionRouteSource.indexOf('const applySessionTabs = useCallback')
    const end = sessionRouteSource.indexOf('const readMarkdownTab', start)
    const block = sessionRouteSource.slice(start, end)

    const followsHost = block.indexOf("const followsHost = result.navigationIntent === 'follow'")
    const pendingHandle = block.indexOf('const pendingActiveTerminalHandle = followsHost')

    expect(followsHost).toBeGreaterThanOrEqual(0)
    expect(pendingHandle).toBeGreaterThan(followsHost)
    expect(block.slice(pendingHandle, pendingHandle + 150)).toContain('? null')
  })

  it('activates the previous viewed tab after closing the current one', () => {
    const start = sessionRouteSource.indexOf('async function handleCloseSessionTab')
    const end = sessionRouteSource.indexOf('const bulkCloseActions', start)
    const block = sessionRouteSource.slice(start, end)

    expect(block).toContain('pickNextTabAfterClose')
    expect(block).toContain('switchSessionTab(nextTab)')
  })
})
