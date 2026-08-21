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
})
