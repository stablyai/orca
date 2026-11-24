import { existsSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'

/** Prefer checked System32 wsl.exe to avoid PATH hijacking (#15749); use PATH only when that file is absent. */
let cached: string | undefined

export function resolveWslExecutablePath(): string {
  if (cached !== undefined) {
    return cached
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const absolute = pathWin32.join(systemRoot, 'System32', 'wsl.exe')
  // A host with WSL elsewhere still deserves a working call.
  cached = existsSync(absolute) ? absolute : 'wsl.exe'
  return cached
}
