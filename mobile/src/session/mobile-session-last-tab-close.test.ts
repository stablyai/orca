import { describe, expect, it, vi } from 'vitest'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionContentCreateActionsModel } from './use-mobile-session-content-create-actions'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
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

  it('activates the MRU successor for an active close but leaves a background close alone', async () => {
    const tab = (id: string, isActive: boolean): MobileSessionTab => ({
      type: 'markdown',
      id,
      title: id,
      filePath: `/${id}.md`,
      relativePath: `${id}.md`,
      isDirty: false,
      isActive,
      documentVersion: '1'
    })
    const tabs = [tab('a', false), tab('b', true), tab('c', false)]
    const sessionTabsRef = { current: tabs }
    const switchSessionTab = vi.fn()
    const setActiveSessionTabId = vi.fn()
    const scope = {
      client: { sendRequest: vi.fn(async () => ({ ok: true })) },
      worktreeId: 'worktree',
      sessionTabsRef,
      setSessionTabs: vi.fn(),
      reconcileBufferedDraftsRef: { current: vi.fn() },
      closedTabTombstonesRef: { current: new Map<string, number>() },
      activeSessionTabIdRef: { current: 'b' },
      recentSessionTabIdsRef: { current: ['a', 'b'] },
      selectedSessionTabIdRef: { current: 'b' },
      setActiveSessionTabId,
      switchSessionTab
    } as unknown as MobileSessionContentCreateActionsModel
    const { handleCloseSessionTab } = useMobileSessionCloseActions(scope)

    await handleCloseSessionTab(tabs[1])
    expect(switchSessionTab).toHaveBeenCalledWith(tabs[0])
    expect(setActiveSessionTabId).not.toHaveBeenCalledWith(null)

    sessionTabsRef.current = tabs
    scope.activeSessionTabIdRef.current = 'b'
    scope.recentSessionTabIdsRef.current = ['a', 'b']
    switchSessionTab.mockClear()
    setActiveSessionTabId.mockClear()

    await handleCloseSessionTab(tabs[0])
    expect(switchSessionTab).not.toHaveBeenCalled()
    expect(setActiveSessionTabId).not.toHaveBeenCalled()
  })
})
