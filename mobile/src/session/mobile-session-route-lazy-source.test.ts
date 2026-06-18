import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const routeSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

const hostListSource = readFileSync(
  new URL('../../app/h/[hostId]/index.tsx', import.meta.url),
  'utf8'
)

describe('mobile session route laziness', () => {
  it('keeps the routed file as a small lazy wrapper', () => {
    expect(routeSource).toContain("lazy(() => import('./mobile-session-screen'))")
    expect(routeSource).not.toContain('useHostClient')
    expect(routeSource).not.toContain("sendRequest('terminal.list'")
  })

  it('warms the heavy session module after the workspace list is usable', () => {
    expect(hostListSource).toContain('warmMobileSessionScreen')
    expect(hostListSource).toContain('InteractionManager.runAfterInteractions')
  })
})
