import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * agent-browser forks a daemon per browser tab that Orca holds no handle on, and
 * `destroyAllSessions` closes each one by spawning another agent-browser child —
 * hundreds of ms apiece. Left off the will-quit barrier, `app.quit()` fired first and
 * every open tab's daemon outlived the app (#16367).
 */
const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')

function teardownBarrierMembers(): string {
  const start = source.indexOf('settleTeardownWithinDeadline([')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('])', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('quit teardown of agent-browser daemons', () => {
  it('joins the will-quit teardown barrier', () => {
    expect(teardownBarrierMembers()).toContain("{ name: 'browser', promise: browserShutdown }")
  })

  it('captures the destroyAllSessions promise instead of firing and forgetting', () => {
    expect(source).toMatch(
      /const browserShutdown = \(async \(\): Promise<void> => \{[\s\S]*?await runtime\?\.getAgentBrowserBridge\(\)\?\.destroyAllSessions\(\)\s+\}\)\(\)/
    )
    // Why: a second, uncaptured call site is the pre-fix shape — it loses the race to app.quit().
    expect(source.match(/getAgentBrowserBridge\(\)\?\.destroyAllSessions\(\)/g)).toHaveLength(1)
  })
})
