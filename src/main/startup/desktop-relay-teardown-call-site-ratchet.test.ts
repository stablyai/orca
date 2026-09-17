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
 * The quit *module* is not the unit — the handler is. `before-quit` is vetoable (a renderer
 * beforeunload can cancel it) and nothing clears `stopped`, so a terminal stop() there kills Relay
 * for the rest of the session on a quit the user backed out of. `will-quit` is the committed path.
 * The file already splits `desktopPushService` exactly this way, for exactly this reason.
 *
 * This test is the compile error those swaps cannot produce. Every direction matters: the vetoable
 * handler must not latch, the committed handler must, and sign-out/relaunch must keep the fence —
 * collapsing any pair destroys the distinction the defect came from.
 *
 * If you are here because this went red on a refactor that looks harmless, that is the intended
 * trade: a ratchet that fails loudly on a benign change beats one that passes silently on a
 * harmful one. Re-read which teardown your call site now runs before relaxing the pattern.
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

/** Body of one `function install<Name>Handler()`, up to the next top-level `function`. */
function handlerBody(source: string, installer: string): string {
  const start = source.indexOf(`function ${installer}(`)
  expect(start, `${installer} not found — the ratchet cannot see what it guards`).toBeGreaterThan(
    -1
  )
  const rest = source.slice(start)
  const end = rest.indexOf('\nfunction ', 1)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('desktop relay teardown call sites', () => {
  it('fences the relay on the vetoable quit handler, and never latches it there', () => {
    const beforeQuit = handlerBody(startupSource(QUIT_MODULE), 'installBeforeQuitHandler')

    expect(beforeQuit).toMatch(RELAY_REARMABLE_FENCE)
    // The latch has nothing that clears it, so a vetoed quit would end Relay for the session.
    expect(beforeQuit).not.toMatch(RELAY_TERMINAL_STOP)
  })

  it('ends the relay terminally on the committed quit handler', () => {
    const willQuit = handlerBody(startupSource(QUIT_MODULE), 'installWillQuitHandler')

    expect(willQuit).toMatch(RELAY_TERMINAL_STOP)
    expect(willQuit).not.toMatch(RELAY_REARMABLE_FENCE)
  })

  it('keeps sign-out and relaunch on the fence, so the next auth mutation re-arms', () => {
    const source = startupSource(AUTH_LIFECYCLE_MODULE)

    expect(source).toMatch(RELAY_REARMABLE_FENCE)
    expect(source).not.toMatch(RELAY_TERMINAL_STOP)
  })
})
