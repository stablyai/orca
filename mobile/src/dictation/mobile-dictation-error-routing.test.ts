import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

function routeSlice(anchorStart: string, anchorEnd: string): string {
  const start = sessionRouteSource.indexOf(anchorStart)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = sessionRouteSource.indexOf(anchorEnd, start)
  expect(end).toBeGreaterThan(start)
  return sessionRouteSource.slice(start, end)
}

describe('mobile dictation error routing', () => {
  it('keeps setup tokens out of startup and in-flight error toasts', () => {
    const owner = routeSlice(
      'function handleDictationError(err: unknown)',
      'const dictation = useMobileDictation({'
    )
    expect(owner).toContain('isDictationSetupRequiredError(error.message)')
    expect(owner).toContain('setShowDictationSetup(true)')

    const hook = routeSlice('const dictation = useMobileDictation({', 'const startDictation')
    expect(hook).toContain('handleDictationError(err)')

    const start = routeSlice('const startDictation', 'const cancelDictation')
    expect(start).toContain('handleDictationError(err)')
    expect(start).not.toContain('showToast(')
    expect(sessionRouteSource.match(/handleDictationError\(err\)/g)).toHaveLength(2)
  })
})
