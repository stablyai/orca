import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../app/h/[hostId]/index.tsx', import.meta.url), 'utf8')

function sliceBetween(startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('mobile worktree activation', () => {
  it('opens mobile sessions without foregrounding other paired clients', () => {
    const openSession = sliceBetween(
      'const openWorktreeSession = useCallback(',
      'const handleSortChange = useCallback'
    )

    expect(openSession).toContain("sendRequest('worktree.activate'")
    expect(openSession).toContain('notifyClients: false')
    expect(openSession).toContain("navigation: 'caller'")
  })
})
