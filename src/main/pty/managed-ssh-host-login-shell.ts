import { existsSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'
import { readOpenSshDefaultShell } from '../../shared/openssh-default-shell'

/** Match relay DefaultShell for SSH-managed Windows hosts only; desktop and user-started servers retain their defaults (#9327). */
export function resolveManagedSshHostLoginShell(
  env: NodeJS.ProcessEnv = process.env,
  existsPath: (path: string) => boolean = existsSync,
  readDefaultShell: () => string = readOpenSshDefaultShell
): string | undefined {
  if (process.platform !== 'win32' || !env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]) {
    return undefined
  }
  const shell = readDefaultShell()
  // Agent planners quote for PowerShell; cmd/bash would receive the wrong command syntax.
  const name = pathWin32.basename(shell).toLowerCase()
  if (name !== 'pwsh.exe' && name !== 'powershell.exe') {
    return undefined
  }
  return existsPath(shell) ? shell : undefined
}
