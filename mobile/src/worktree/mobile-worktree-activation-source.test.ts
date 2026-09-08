import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const screenSource = readFileSync(
  new URL('../host-screen/use-hybrid-host-worktree-actions.ts', import.meta.url),
  'utf8'
)
const adapterSource = readFileSync(
  new URL('./native-host-workspace-operations.ts', import.meta.url),
  'utf8'
)

function sliceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('mobile worktree activation', () => {
  it('opens mobile sessions without foregrounding other paired clients', () => {
    const openSession = sliceBetween(
      screenSource,
      'const openWorktreeSession = useCallback(',
      'return {'
    )
    const nativeActivation = sliceBetween(
      adapterSource,
      'async activateWorkspace',
      'async sleepWorkspace'
    )

    expect(openSession).toContain('operations.activateWorkspace')
    expect(nativeActivation).toContain("sendRequest('worktree.activate'")
    expect(nativeActivation).toContain('notifyClients: false')
    expect(nativeActivation).toContain("navigation: 'caller'")
  })
})
