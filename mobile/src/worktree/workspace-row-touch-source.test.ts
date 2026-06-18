import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const rowSource = readFileSync(
  new URL('../components/WorktreeListRow.tsx', import.meta.url),
  'utf8'
)
const hostListSource = readFileSync(
  new URL('../../app/h/[hostId]/index.tsx', import.meta.url),
  'utf8'
)

describe('workspace row touch behavior', () => {
  it('does not trigger selection from press-in while the list may still scroll', () => {
    expect(rowSource).not.toContain('onPressIn')
  })

  it('keeps haptics on the confirmed tap path', () => {
    const openHandlerStart = hostListSource.indexOf('const openWorktreeSession = useCallback')
    expect(openHandlerStart).toBeGreaterThanOrEqual(0)
    const openHandler = hostListSource.slice(
      openHandlerStart,
      hostListSource.indexOf('const handleSortChange', openHandlerStart)
    )
    expect(openHandler).toContain('openWorkspaceSession')
    expect(openHandler).toContain('triggerSelection()')
  })
})
