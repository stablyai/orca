import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { parseWslUncPath } from '../../shared/wsl-paths'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Why: host Node mkdir on \\wsl.localhost UNC throws EISDIR when the guest dir exists or 9P is mid-attach (#15441). */
export function ensureWslRuntimeHomeDirectory(runtimeHomePath: string): void {
  if (isDirectory(runtimeHomePath)) {
    return
  }

  try {
    mkdirSync(runtimeHomePath, { recursive: true })
  } catch (error) {
    if (isDirectory(runtimeHomePath)) {
      return
    }
    const parsed = parseWslUncPath(runtimeHomePath)
    if (!parsed) {
      throw error
    }
    execFileSync(
      'wsl.exe',
      buildWslExecArgs(parsed.distro, ['mkdir', '-p', '--', parsed.linuxPath]),
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }
    )
  }
}
