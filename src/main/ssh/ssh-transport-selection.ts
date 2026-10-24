import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './config/ssh-g-config-resolution'
import { listDefaultIdentityFilePaths, resolveIdentityFilePaths } from './ssh-auth-resolution'
import { resolveSshConfigHomePath } from './config/ssh-config-path-expansion'
import {
  isOpenSshSecurityKeyPrivateKey,
  isOpenSshSecurityKeyPublicKey
} from './ssh-security-key-identity'
import { readSshIdentityFile } from './ssh-identity-file-read'
import { isOpenSshConfigBackedTarget } from './system-transport/system-ssh-args'
import { findSystemSsh } from './system-transport/system-ssh-binary'

type TransportResolvedConfig = Pick<
  SshResolvedConfig,
  'proxyUseFdpass' | 'proxyCommand' | 'proxyJump'
>

async function identityRequiresSystemSsh(keyPath: string): Promise<boolean> {
  const resolvedPath = resolveSshConfigHomePath(keyPath)
  const identity = (await readSshIdentityFile(resolvedPath)).contents
  // Why: a present private key wins; a `.pub` beside it may describe a key already replaced.
  if (identity !== null) {
    return isOpenSshSecurityKeyPublicKey(identity) || isOpenSshSecurityKeyPrivateKey(identity)
  }
  const publicIdentity = (await readSshIdentityFile(`${resolvedPath}.pub`)).contents
  return publicIdentity !== null && isOpenSshSecurityKeyPublicKey(publicIdentity)
}

export function shouldUseSystemSshTransport(
  target: SshTarget,
  resolved: TransportResolvedConfig | null
): boolean {
  if (isOpenSshConfigBackedTarget(target) && resolved) {
    return (
      process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT === '1' ||
      resolved.proxyUseFdpass === true ||
      resolved.proxyCommand != null ||
      resolved.proxyJump != null
    )
  }
  return (
    process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT === '1' ||
    target.proxyCommand != null ||
    target.jumpHost != null ||
    resolved?.proxyUseFdpass === true ||
    resolved?.proxyCommand != null ||
    resolved?.proxyJump != null
  )
}

export async function requiresSystemSshForSecurityKey(
  target: SshTarget,
  resolved: Pick<SshResolvedConfig, 'identityFile'> | null
): Promise<boolean> {
  const resolvedPaths = resolveIdentityFilePaths(target, resolved)
  // Why: `ssh -G` already echoes OpenSSH's built-in defaults, so its list is the real candidate
  // set; guess at the defaults only when config resolution failed outright.
  const identityPaths =
    resolvedPaths.length === 0 && !resolved && !target.identityFile
      ? listDefaultIdentityFilePaths()
      : resolvedPaths
  for (const keyPath of identityPaths) {
    if (await identityRequiresSystemSsh(keyPath)) {
      // Why: scan every candidate — an earlier normal key never rules out a security key the host
      // requires — but forcing system transport with no binary hard-fails a connection ssh2 could
      // still have served over agent or password auth.
      return findSystemSsh() !== null
    }
  }
  return false
}
