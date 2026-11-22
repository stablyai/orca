import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import { findPrivateRuntimeDirectory } from '../../filesystem/private-runtime-directory'
import type { SshTarget } from '../../../shared/remote-runtime/ssh/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'

export type SystemSshResolvedConfig = Pick<
  SshResolvedConfig,
  | 'hostname'
  | 'port'
  | 'user'
  | 'identityFile'
  | 'identityAgent'
  | 'identitiesOnly'
  | 'forwardAgent'
  | 'proxyCommand'
  | 'proxyJump'
  | 'proxyUseFdpass'
  | 'controlMaster'
  | 'controlPath'
  | 'controlPersist'
>

const OPENSSH_CONTROL_SOCKET_SUFFIX_BUDGET = 18
const UNIX_SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 104 : 108
const CONTROL_SOCKET_PATH_MAX_LENGTH = UNIX_SOCKET_PATH_LIMIT - OPENSSH_CONTROL_SOCKET_SUFFIX_BUDGET

export function getControlSocketPath(
  target: SshTarget,
  resolvedConfig?: SystemSshResolvedConfig | null,
  gssapiOnly = false
): string | null {
  if (process.platform === 'win32') {
    return null
  }
  const uid = process.getuid?.()
  if (uid === undefined) {
    return null
  }

  const dir = findPrivateRuntimeDirectory('orca-ssh', uid)
  if (!dir) {
    return null
  }

  // Include persisted and freshly resolved config so route edits cannot reuse a live stale ControlPersist master.
  const key = JSON.stringify({
    target: {
      id: target.id,
      configHost: target.configHost || '',
      host: target.host || '',
      port: target.port || 22,
      user: target.username || '',
      proxyCommand: target.proxyCommand || '',
      jumpHost: target.jumpHost || '',
      identityFile: target.identityFile || '',
      identityAgent: target.identityAgent || '',
      identitiesOnly: target.identitiesOnly || false
    },
    resolved: normalizeResolvedConfig(resolvedConfig),
    // Kerberos-only auth must not reuse a key-authenticated master.
    gssapiOnly
  })
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const socketPath = pathJoin(dir, hash)
  return socketPath.length <= CONTROL_SOCKET_PATH_MAX_LENGTH ? socketPath : null
}

export function removeControlSocketPath(socketPath: string): void {
  try {
    rmSync(socketPath, { force: true })
  } catch {}
}

function normalizeResolvedConfig(
  resolvedConfig: SystemSshResolvedConfig | null | undefined
): Record<string, unknown> | null {
  if (!resolvedConfig) {
    return null
  }
  return {
    hostname: resolvedConfig.hostname || '',
    port: resolvedConfig.port || 22,
    user: resolvedConfig.user || '',
    identityFile: resolvedConfig.identityFile ?? [],
    identityAgent: resolvedConfig.identityAgent || '',
    identitiesOnly: resolvedConfig.identitiesOnly || false,
    forwardAgent: resolvedConfig.forwardAgent || false,
    proxyCommand: resolvedConfig.proxyCommand || '',
    proxyJump: resolvedConfig.proxyJump || '',
    proxyUseFdpass: resolvedConfig.proxyUseFdpass || false,
    controlMaster: resolvedConfig.controlMaster || 'no',
    controlPath: resolvedConfig.controlPath || '',
    controlPersist: resolvedConfig.controlPersist || 'no'
  }
}
