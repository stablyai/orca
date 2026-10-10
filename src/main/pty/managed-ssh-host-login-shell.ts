import { existsSync } from 'node:fs'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-idle-exit'
import { readOpenSshDefaultShell } from '../../shared/openssh-default-shell'

/**
 * The OpenSSH `DefaultShell` a Windows SSH login would get, but only for an orcad a client
 * launched over SSH (#9327), matching the relay. Desktop and user-started servers never read it.
 */
export function resolveManagedSshHostLoginShell(
  env: NodeJS.ProcessEnv = process.env,
  existsPath: (path: string) => boolean = existsSync,
  readDefaultShell: () => string = readOpenSshDefaultShell
): string | undefined {
  if (process.platform !== 'win32' || !env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]) {
    return undefined
  }
  const shell = readDefaultShell()
  return shell && existsPath(shell) ? shell : undefined
}
