import { wslAwareSpawn } from '../git/runner'

const RG_AVAILABILITY_TIMEOUT_MS = 5000

// Why the `settled` flag: when rg is not installed, spawn emits both 'error'
// and 'close' with non-deterministic ordering across Node versions/platforms.
// Without guarding, a late 'error' after 'close' would double-resolve (or a
// late 'close' after 'error' would resolve true after we already resolved
// false). `settled` makes whichever fires first authoritative.
//
// Why no cache: `rg --version` is a sub-10ms spawn, so the cost of checking
// per call is negligible. Caching had a footgun in both directions — a
// negative cache persisted across rg installs (forcing an app restart),
// while a positive cache could mask an rg that was uninstalled or broken
// mid-session.

export function checkRgAvailable(searchPath?: string, wslDistro?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    // Why: pass cwd plus project-runtime distro so WSL projects are checked
    // inside their distro even when the search root is a Windows path.
    const child = wslAwareSpawn('rg', ['--version'], {
      ...(searchPath ? { cwd: searchPath } : {}),
      ...(wslDistro ? { wslDistro } : {}),
      stdio: 'ignore'
    })
    let timeout: ReturnType<typeof setTimeout>

    const cleanup = (): void => {
      clearTimeout(timeout)
      child.off('error', onError)
      child.off('close', onClose)
    }

    const settle = (available: boolean, options?: { kill?: boolean }): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (options?.kill) {
        child.kill()
      }
      resolve(available)
    }

    const onError = (): void => settle(false)
    const onClose = (code: number | null): void => settle(code === 0)

    child.once('error', onError)
    child.once('close', onClose)
    timeout = setTimeout(() => settle(false, { kill: true }), RG_AVAILABILITY_TIMEOUT_MS)
    if (typeof timeout.unref === 'function') {
      timeout.unref()
    }
  })
}
