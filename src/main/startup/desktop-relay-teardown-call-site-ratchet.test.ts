import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard which DesktopRelayService teardown each lifecycle event calls.
 *
 * `stop()` is terminal; `fenceAndCloseNow()` is re-armable by design, so sign-out comes back on the
 * next auth mutation. Nothing in the types says so — both take an optional argument and return
 * void, so swapping one for the other compiles clean and passes every unit test. Quit used the
 * fence, and a settling mint, a pending invite expiry or a power-resume `ensureLive` each reopened
 * a broker after quit; the damage only shows up in timer state, minutes later.
 *
 * This test is the compile error that swap cannot produce. Both directions matter: quit must not
 * regain the re-armable fence, and sign-out/relaunch must not lose it — collapsing them either way
 * destroys the distinction the defect came from.
 */
const STARTUP_DIR = __dirname
const QUIT_MODULE = 'main-process-quit.ts'
const AUTH_LIFECYCLE_MODULE = 'main-window-core-services.ts'

// Qualified by the receiver on purpose: the quit handler stops five unrelated services, so a bare
// `.stop()` would match `rateLimits`, `starNag`, `automations` and the rest. Literal enough that
// hoisting the call behind a local also trips it — a refactor that hides which teardown runs at
// quit is exactly what should get a second look.
const RELAY_TERMINAL_STOP = /desktopRelayService\?\.stop\(\)/
const RELAY_REARMABLE_FENCE = /desktopRelayService\?\.fenceAndCloseNow\(/

function startupSource(module: string): string {
  return readFileSync(join(STARTUP_DIR, module), 'utf8')
}

describe('desktop relay teardown call sites', () => {
  it('ends the relay terminally at quit, never through the re-armable fence', () => {
    const source = startupSource(QUIT_MODULE)

    expect(source).toMatch(RELAY_TERMINAL_STOP)
    expect(source).not.toMatch(RELAY_REARMABLE_FENCE)
  })

  it('keeps sign-out and relaunch on the fence, so the next auth mutation re-arms', () => {
    const source = startupSource(AUTH_LIFECYCLE_MODULE)

    expect(source).toMatch(RELAY_REARMABLE_FENCE)
    expect(source).not.toMatch(RELAY_TERMINAL_STOP)
  })
})
