import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards where the committed-quit crumb is written, which is the whole of its
 * meaning: on before-quit it would claim exits a renderer beforeunload vetoed,
 * and anywhere after the teardown barrier it would go missing on every quit the
 * deadline or a force-quit cuts short. Source-level because the placement is a
 * property of one composition root with no runtime seam to assert against.
 */
describe('committed-quit breadcrumb startup wiring', () => {
  // Why normalize: the indent anchors below are `\n`-prefixed and nothing pins
  // src/**/*.ts to LF, so a CRLF Windows checkout would fail them spuriously.
  const source = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-quit.ts'),
    'utf8'
  ).replace(/\r\n/g, '\n')

  const willQuitStart = source.indexOf('function installWillQuitHandler(): void {')
  const willQuitBody = source.slice(willQuitStart).split('\nfunction ')[0]
  const beforeQuitStart = source.indexOf('function installBeforeQuitHandler(): void {')
  const beforeQuitBody = source.slice(beforeQuitStart).split('\nfunction ')[0]

  it('writes the crumb exactly once, inside will-quit and past the commit gate', () => {
    expect(willQuitStart).toBeGreaterThanOrEqual(0)
    expect(beforeQuitStart).toBeGreaterThanOrEqual(0)
    expect(source).toContain(
      "import { recordCommittedQuitBreadcrumb } from '../crash-reporting/committed-quit-breadcrumb'"
    )
    expect(source.split('recordCommittedQuitBreadcrumb({').length - 1).toBe(1)
    // Why the veto path is asserted empty: a crumb there is a lie in the other
    // direction — it claims an exit for a quit the renderer went on to cancel.
    expect(beforeQuitBody).not.toContain('recordCommittedQuitBreadcrumb')
    expect(willQuitBody).toContain('recordCommittedQuitBreadcrumb({')
    // Why pin the indent: the call also matches as the body of an added `if (...)`
    // guard, which keeps every other assertion here true while most quits stop
    // writing the crumb and read as abrupt deaths on the next launch.
    expect(willQuitBody).toContain('\n    recordCommittedQuitBreadcrumb({')
  })

  it('writes it after the commit gate and before the teardown barrier', () => {
    const gateIndex = willQuitBody.indexOf('if (!quitTeardownStartGate.tryStart(event)) {')
    const crumbIndex = willQuitBody.indexOf('recordCommittedQuitBreadcrumb({')
    // Why the barrier is the other bound: past it the crumb rides on teardown finishing,
    // so the 20s deadline and a force-quit would each drop it from a quit that committed.
    const barrierIndex = willQuitBody.indexOf('settleTeardownWithinDeadline([')

    expect(gateIndex).toBeGreaterThanOrEqual(0)
    expect(barrierIndex).toBeGreaterThan(gateIndex)
    expect(crumbIndex).toBeGreaterThan(gateIndex)
    expect(crumbIndex).toBeLessThan(barrierIndex)
  })
})
