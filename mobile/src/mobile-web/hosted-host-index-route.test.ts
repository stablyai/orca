import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const hostedRoot = new URL('../../host-web-app/', import.meta.url)
const hostIndexRoute = new URL('h/[hostId]/index.tsx', hostedRoot)
const leaveSessionSource = readFileSync(
  new URL('../session/use-mobile-session-markdown-actions.ts', import.meta.url),
  'utf8'
)
const bounceSource = readFileSync(new URL('../host-route-notice.ts', import.meta.url), 'utf8')

describe('hosted host index route', () => {
  it('serves the host index that shared session exits navigate to', () => {
    // Both exits target /h/<hostId>; a hosted page without that route renders Unmatched Route.
    expect(leaveSessionSource).toContain('router.replace(`/h/${hostId}`)')
    expect(bounceSource).toContain('`/h/${encodeURIComponent(hostId)}?notice=${notice}`')
    expect(existsSync(hostIndexRoute)).toBe(true)
    expect(readFileSync(hostIndexRoute, 'utf8')).toContain("export { default } from '../../index'")
  })
})
