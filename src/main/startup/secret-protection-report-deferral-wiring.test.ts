import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the one line that decides whether the OS keyring gates the first window.
 *
 * The report is diagnostics nothing on the startup path reads, but `describeProtectionGap()`
 * is a blocking D-Bus round trip on Linux, and a present-but-locked keyring never answers —
 * 76s to first window on Ubuntu 24.04 (STA-5765). Both directions of the one flag here are
 * silent: `true` gives headless serve a deferral it must never have (serve opens no window,
 * so only the fallback fires, after clients may have paired, and a frozen main thread reads
 * as a dead host); `false` puts the blocking probe back in front of the window. Deleting the
 * call entirely restores the original regression.
 *
 * Source-level because that is the property: this runs once inside `app.whenReady()` during
 * startup, so there is no seam to assert against at runtime.
 */
describe('secret protection report deferral wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  const SCHEDULE = 'scheduleSecretProtectionGapReport({'

  it('arms the deferred report exactly once and never calls the blocking one directly', () => {
    expect(source.split(SCHEDULE).length - 1, `${SCHEDULE} should appear exactly once`).toBe(1)
    expect(source).toContain(
      "import { scheduleSecretProtectionGapReport } from './host/deferred-secret-protection-report'"
    )
    // Why also assert the absence: re-importing the blocking entry point reinstates the
    // pre-window probe without touching the call site the next test pins. Note the scheduling
    // name is `...GapReport(`, so it does not match this substring.
    expect(source.split('reportSecretProtectionGap(').length - 1).toBe(0)
  })

  it('defers on desktop and reports inline in headless serve', () => {
    const start = source.indexOf(SCHEDULE)
    // Why bound every anchor: an unresolved one is -1, and the slice below would then run to
    // EOF and pass against unrelated code.
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('\n  })', start)
    expect(end).toBeGreaterThan(start)
    // Why bound the length too: `end` is the next call-shaped close at this indent, not
    // necessarily this call's. Nest the call one level deeper and that anchor overshoots into
    // unrelated code, so the assertions below pass against a call site that never runs.
    expect(end - start).toBeLessThan(500)
    const call = source.slice(start, end)

    // Why anchor the indent: `SCHEDULE` matches anywhere, including as the body of an added
    // `if (...) schedule(...)` guard, which leaves every assertion here true while the call
    // stops running unconditionally. Pinning it as a statement at whenReady's own indent is
    // what makes "this runs on every desktop startup" the thing under test.
    expect(source).toContain(`\n  ${SCHEDULE}`)

    expect(call).toContain('deferUntilFirstWindow: !isServeMode')
    // Why assert the constants are absent too: `!isServeMode` being present does not stop a
    // later property in the same literal from overriding it.
    expect(call).not.toContain('deferUntilFirstWindow: true')
    expect(call).not.toContain('deferUntilFirstWindow: false')
  })

  it('arms the report after the profile exists and inside app readiness', () => {
    // Why: the report remembers what it last said beside the profile data file, so arming it
    // before the profile is resolved would key the state off a path that does not exist yet.
    // Anchored on code, never a comment — a reworded comment silently becomes -1.
    const ready = source.indexOf('app.whenReady().then(')
    const profile = source.indexOf('const activeOrcaProfile = ensureActiveOrcaProfile()')
    const schedule = source.indexOf(SCHEDULE)

    expect(ready).toBeGreaterThanOrEqual(0)
    expect(profile).toBeGreaterThan(ready)
    expect(schedule).toBeGreaterThan(profile)
  })
})
