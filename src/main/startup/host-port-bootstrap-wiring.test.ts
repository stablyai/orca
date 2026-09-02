import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the single point of failure for every host port.
 *
 * The ports deliberately split two ways when uninstalled: AppEnvironment and SecretStore
 * throw, because a silent default writes real user state to the wrong place; the rest
 * default to no-ops or inert stubs, because a host with no renderer legitimately has
 * nothing to register. That asymmetry is only safe while the desktop installs all of
 * them before anything reads state — a dropped or reordered line here does not fail a
 * unit test, it silently degrades the shipped app (worktree removal stops closing
 * watchers, notifications stop firing, browser panes start rejecting).
 *
 * Source-level because that is the property: these run once at module scope during
 * startup, so there is no seam to assert against at runtime.
 */
describe('host port bootstrap wiring', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
    'utf8'
  )
  const entrySource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  const INSTALLS = [
    'setAppEnvironment(new ElectronAppEnvironment())',
    'setSecretStore(new ElectronSecretStore())',
    'setPtyHostBindings({',
    'setRuntimeDesktopSurface(electronRuntimeDesktopSurface)',
    'setRuntimeBrowserCommandsFactory(electronRuntimeBrowserCommandsFactory)',
    'setDefaultProxySessionResolver(',
    'setMainHttpClient(electronHttpClient)',
    'setSpeechServiceFactories(electronSpeechServiceFactories)',
    'setWorktreeWatcherRemoval(desktopWorktreeWatcherRemoval)'
  ]

  it('installs every host port exactly once', () => {
    for (const install of INSTALLS) {
      expect(source.split(install).length - 1, `${install} should appear exactly once`).toBe(1)
    }
  })

  it('installs every port during preflight before it hands off to ready services', () => {
    // Why: the ready phase creates the runtime, PTY handlers, and windows. Keeping all host-port
    // installs in the preflight phase preserves process-level defaults for both desktop and serve.
    const preflightStart = source.indexOf('export function runMainProcessPreflight(')
    const preflightReturn = source.indexOf('\n  return true', preflightStart)
    const readyPhase = entrySource.indexOf('void app.whenReady().then(async () => {')
    const preflightCall = entrySource.indexOf('runMainProcessPreflight({')
    expect(preflightStart).toBeGreaterThanOrEqual(0)
    expect(preflightReturn).toBeGreaterThan(preflightStart)
    expect(preflightCall).toBeGreaterThanOrEqual(0)
    expect(readyPhase).toBeGreaterThan(preflightCall)
    for (const install of INSTALLS) {
      const installIndex = source.indexOf(install)
      expect(installIndex, `${install} should run in preflight`).toBeGreaterThan(preflightStart)
      expect(installIndex, `${install} should run before preflight completes`).toBeLessThan(
        preflightReturn
      )
    }
  })

  it('installs the app environment as part of the userData decision, not after it', () => {
    // Why (#16761): the accessor throws until installed, and `getCanonicalUserDataPath()` memoizes
    // whatever it first resolves. Any gap between deciding where userData lives and installing the
    // port is a window where an early path resolve either kills the process — which is what took
    // down every macOS `orca serve` — or caches the pre-override directory for the whole session.
    // Keeping the four statements adjacent is what makes that window zero rather than merely small.
    const decide = source.indexOf('configureDevUserDataPath(isDev)')
    const install = source.indexOf('setAppEnvironment(new ElectronAppEnvironment())')
    const capture = source.indexOf('initDataPath()')

    expect(decide).toBeGreaterThanOrEqual(0)
    expect(install).toBeGreaterThan(decide)
    expect(capture).toBeGreaterThan(install)

    const statements = source
      .slice(decide, capture)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'))

    expect(statements).toEqual([
      'configureDevUserDataPath(isDev)',
      'configureOrcaUserDataPathEnv()',
      'setAppEnvironment(new ElectronAppEnvironment())'
    ])
  })

  it('installs the ports at process level, not per window', () => {
    // Why: installing per window registered the PTY surfaces against no-ops on the
    // serve path, where no window ever opens. Caught in CI by the SSH docker E2E.
    const readyPhase = entrySource.indexOf('void app.whenReady().then(async () => {')
    const preflightCall = entrySource.indexOf('runMainProcessPreflight({')
    expect(preflightCall).toBeGreaterThanOrEqual(0)
    expect(readyPhase).toBeGreaterThan(preflightCall)
    for (const install of INSTALLS) {
      expect(source.split(install).length - 1, `${install} should be owned by preflight`).toBe(1)
    }
  })
})
