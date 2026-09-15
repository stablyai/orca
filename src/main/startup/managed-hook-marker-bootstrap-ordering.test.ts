import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The marker decides whether this installation predates the first-run hook question, and it decides
 * it by looking for Orca's own state at the user-data root. Anything that creates a profile, a
 * Store, or the legacy data file first would make a genuinely fresh install look pre-existing — the
 * feature would silently never defer, and no unit test would notice.
 *
 * Source-level because that is the property: this runs once at module scope before `ready`, so
 * there is no runtime seam to assert the ordering against.
 */
describe('managed hook installation marker bootstrap ordering', () => {
  const preflight = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
    'utf8'
  )
  const entry = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  const ESTABLISH = 'establishManagedHookInstallationMarker(getCanonicalUserDataPath())'
  const INSTALL_RESOLVER = 'setManagedHookInstallDecisionResolver('

  it('establishes the marker exactly once, in preflight', () => {
    const preflightStart = preflight.indexOf('export function runMainProcessPreflight(')
    const preflightReturn = preflight.indexOf('\n  return true', preflightStart)
    const establish = preflight.indexOf(ESTABLISH)

    expect(preflight.split(ESTABLISH).length - 1).toBe(1)
    expect(establish).toBeGreaterThan(preflightStart)
    expect(establish).toBeLessThan(preflightReturn)
  })

  it('runs after the user-data path is captured, so it reads the right root', () => {
    expect(preflight.indexOf(ESTABLISH)).toBeGreaterThan(preflight.indexOf('  initDataPath()'))
  })

  it('runs after the single-instance lock, so a losing launch mints nothing', () => {
    expect(preflight.indexOf(ESTABLISH)).toBeGreaterThan(
      preflight.indexOf('const hasLock = skip || bypass || acquireSingleInstanceLock(')
    )
  })

  it('runs before anything that could create the state it looks for', () => {
    const establish = preflight.indexOf(ESTABLISH)
    // initOrcaProfilePaths only captures a path today, but it is the nearest profile-shaped step
    // and the one a future change would most plausibly grow a mkdir into.
    expect(establish).toBeLessThan(preflight.indexOf('initOrcaProfilePaths()'))
  })

  it('installs the policy resolver alongside it, before the ready phase runs', () => {
    const resolver = preflight.indexOf(INSTALL_RESOLVER)

    expect(preflight.split(INSTALL_RESOLVER).length - 1).toBe(1)
    expect(resolver).toBeGreaterThan(preflight.indexOf(ESTABLISH))
    expect(entry.indexOf('void app.whenReady()')).toBeGreaterThan(
      entry.indexOf('runMainProcessPreflight({')
    )
  })

  it('passes the serve host its own mode, so a serve launch never defers', () => {
    expect(preflight).toContain("mode: state.isServeMode ? 'serve' : 'desktop'")
  })
})
