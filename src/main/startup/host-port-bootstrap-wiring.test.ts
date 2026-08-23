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
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

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

  it('installs every port before the runtime, the PTY handlers, or any window exists', () => {
    // Why these three: they are the first things that resolve a path, seal a credential,
    // or register against an injected surface.
    const firstUse = Math.min(
      ...['new OrcaRuntimeService(', 'registerHeadlessPtyRuntime(', 'function openMainWindow(']
        .map((marker) => source.indexOf(marker))
        .filter((index) => index >= 0)
    )
    expect(firstUse).toBeGreaterThan(0)

    for (const install of INSTALLS) {
      expect(source.indexOf(install), `${install} must run before first use`).toBeLessThan(firstUse)
    }
  })

  it('installs the ports at process level, not per window', () => {
    // Why: installing per window registered the PTY surfaces against no-ops on the
    // serve path, where no window ever opens. Caught in CI by the SSH docker E2E.
    const openWindow = source.indexOf('function openMainWindow(')
    for (const install of INSTALLS) {
      expect(
        source.indexOf(install, openWindow),
        `${install} must not be re-installed per window`
      ).toBe(-1)
    }
  })
})
