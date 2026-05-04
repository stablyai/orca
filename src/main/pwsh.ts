import { execFileSync } from 'child_process'

// Cached pwsh availability check — evaluated once per process lifetime
let pwshAvailableCache: boolean | null = null

/**
 * Check whether pwsh.exe is available on this Windows machine.
 * Result is cached for the process lifetime.
 */
export function isPwshAvailable(): boolean {
  if (pwshAvailableCache !== null) {
    return pwshAvailableCache
  }

  if (process.platform !== 'win32') {
    pwshAvailableCache = false
    return false
  }

  try {
    execFileSync('pwsh.exe', ['-Version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    pwshAvailableCache = true
  } catch {
    pwshAvailableCache = false
  }

  return pwshAvailableCache
}
