import { wslAwareSpawn } from '../git/runner'
import { terminateSpawnedChild } from '../../shared/spawned-child-cancellation'

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

export function checkRgAvailable(
  searchPath?: string,
  wslDistro?: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.reject(createRgAvailabilityAbortError())
  }
  return new Promise((resolve, reject) => {
    let settled = false
    // Why: pass cwd plus project-runtime distro so WSL projects are checked
    // inside their distro even when the search root is a Windows path.
    const child = wslAwareSpawn('rg', ['--version'], {
      ...(searchPath ? { cwd: searchPath } : {}),
      ...(wslDistro ? { wslDistro } : {}),
      stdio: 'ignore'
    })
    let timeout: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      child.off('error', onError)
      child.off('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }

    const settle = (available: boolean, options?: { kill?: boolean }): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (options?.kill) {
        terminateSpawnedChild(child)
      }
      resolve(available)
    }

    const onError = (): void => settle(false)
    const onClose = (code: number | null): void => settle(code === 0)
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      terminateSpawnedChild(child)
      reject(createRgAvailabilityAbortError())
    }

    child.once('error', onError)
    child.once('close', onClose)
    timeout = setTimeout(() => settle(false, { kill: true }), RG_AVAILABILITY_TIMEOUT_MS)
    if (typeof timeout.unref === 'function') {
      timeout.unref()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}

function createRgAvailabilityAbortError(): Error {
  const error = new Error('rg availability check aborted')
  error.name = 'AbortError'
  return error
}
