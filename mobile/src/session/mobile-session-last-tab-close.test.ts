import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

describe('mobile session last-tab close', () => {
  it('preserves terminal identity while an empty snapshot may be transient', () => {
    const start = sessionRouteSource.indexOf('const applySessionTabs = useCallback')
    const end = sessionRouteSource.indexOf('const readMarkdownTab', start)
    const block = sessionRouteSource.slice(start, end)

    expect(block).toContain('} else if (active) {')
  })

  it('clears stale active identity when closing leaves no tabs', () => {
    const start = sessionRouteSource.indexOf('async function handleCloseSessionTab')
    const end = sessionRouteSource.indexOf('const bulkCloseActions', start)
    const block = sessionRouteSource.slice(start, end)

    expect(block).toContain(
      'activeSessionTabIdRef.current === tab.id || remainingTabs.length === 0'
    )
    expect(block).toContain('activeSessionTabIdRef.current = null')
    expect(block).toContain('activeHandleRef.current = null')
  })

  it('switches to the most recently active surviving tab', () => {
    const start = sessionRouteSource.indexOf('async function handleCloseSessionTab')
    const end = sessionRouteSource.indexOf('const bulkCloseActions', start)
    const block = sessionRouteSource.slice(start, end)

    expect(block).toContain('const activeTabIdAtCloseStart = activeSessionTabIdRef.current')
    expect(block).toContain('const sessionTabsAtCloseStart = sessionTabsRef.current')
    expect(block).toContain('const recentTabIdsAtCloseStart = recentSessionTabIdsRef.current')
    expect(block).toContain('shouldRestoreMobileSessionTabAfterClose({')
    expect(block).toContain('pickMobileSessionTabAfterClose(')
    expect(block).toContain('switchSessionTab(replacement)')
  })

  it('preserves a terminal created while a close request is in flight', () => {
    const start = sessionRouteSource.indexOf('async function handleCreateTerminal')
    const end = sessionRouteSource.indexOf('function launchQuickCommand', start)
    const block = sessionRouteSource.slice(start, end)

    expect(block.match(/sessionTabSelectionRevisionRef\.current \+= 1/g)).toHaveLength(2)
    expect(block).toContain('activeSessionTabIdRef.current = created.id')
    expect(block).toContain('sessionTabsRef.current = nextSessionTabs')
    expect(block).toContain('setSessionTabs(nextSessionTabs)')
  })

  it('treats every host follow as a newer selection', () => {
    const start = sessionRouteSource.indexOf('const applySessionTabs = useCallback')
    const end = sessionRouteSource.indexOf('const readMarkdownTab', start)
    const block = sessionRouteSource.slice(start, end)

    expect(block).toContain(
      'if (followsHost) {\n        sessionTabSelectionRevisionRef.current += 1'
    )
  })
})
