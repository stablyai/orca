import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'startup', 'main-process-quit.ts'), 'utf8')

describe('quit teardown of Tailcat', () => {
  it('joins Tailcat disposal to the bounded will-quit barrier', () => {
    const capture = source.indexOf('const tailcatShutdown = disposeTailcatTunnel()')
    const barrier = source.indexOf('settleTeardownWithinDeadline([', capture)

    expect(capture).toBeGreaterThanOrEqual(0)
    expect(barrier).toBeGreaterThan(capture)
    expect(source.slice(barrier)).toContain("{ name: 'tailcat', promise: tailcatShutdown }")
    expect(source.match(/disposeTailcatTunnel\(\)/g)).toHaveLength(1)
  })
})
