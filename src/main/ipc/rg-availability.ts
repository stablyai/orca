import { wslAwareSpawn } from '../git/runner'

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

export function checkRgAvailable(searchPath?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    // Why: pass cwd so wslAwareSpawn routes through wsl.exe when the search
    // path is inside a WSL filesystem. This checks whether rg is available
    // inside the WSL distro rather than on the Windows PATH.
    const child = wslAwareSpawn('rg', ['--version'], {
      ...(searchPath ? { cwd: searchPath } : {}),
      stdio: 'ignore'
    })
    child.once('error', () => {
      if (settled) {
        return
      }
      settled = true
      resolve(false)
    })
    child.once('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      resolve(code === 0)
    })
  })
}
