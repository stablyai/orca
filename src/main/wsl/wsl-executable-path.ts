import { existsSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'

/**
 * Absolute path to `wsl.exe`.
 *
 * Why not the bare name: spawning by name resolves through the child's PATH,
 * which a Group Policy, a stripped Electron environment or a shadowing entry
 * can point somewhere else — the same class of failure W1 fixed for PowerShell
 * (#15749). System32 is the launcher Microsoft ships; the Store package
 * forwards through it.
 */
export function resolveWslExecutablePath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const absolute = pathWin32.join(systemRoot, 'System32', 'wsl.exe')
  // Why the fallback: a host that has WSL somewhere else still deserves a
  // working call, and PATH resolution is strictly better than a path we know
  // is wrong.
  return existsSync(absolute) ? absolute : 'wsl.exe'
}
