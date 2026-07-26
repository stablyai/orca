import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join as pathJoin } from 'node:path'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'

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

  const dir = findControlSocketDirectory(uid)
  if (!dir) {
    return null
  }

  // Why: include both persisted target fields and fresh ssh -G output so a
  // live ControlPersist master is not reused after config-backed routes change.
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
    // Why: a Kerberos-only session must not reuse a master authenticated by a key.
    gssapiOnly
  })
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const socketPath = pathJoin(dir, hash)
  return socketPath.length <= CONTROL_SOCKET_PATH_MAX_LENGTH ? socketPath : null
}

export function removeControlSocketPath(socketPath: string): void {
  try {
    rmSync(socketPath, { force: true })
  } catch {
    // Best-effort stale socket cleanup; the retry can still use `-S none`.
  }
}

function findControlSocketDirectory(uid: number): string | null {
  const candidates = getControlSocketDirectoryCandidates(uid)
  for (const dir of candidates) {
    if (ensurePrivateDirectory(dir, uid)) {
      return dir
    }
  }
  return null
}

function getControlSocketDirectoryCandidates(uid: number): string[] {
  const candidates: string[] = []
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR
  if (xdgRuntimeDir && isAbsolute(xdgRuntimeDir)) {
    candidates.push(pathJoin(xdgRuntimeDir, 'orca-ssh'))
  }
  candidates.push(pathJoin(tmpdir(), `orca-ssh-${uid}`))
  return candidates
}

function ensurePrivateDirectory(dir: string, uid: number): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Why: mkdir mode is ignored for pre-existing dirs; lstat rejects symlink
    // swaps and the owner/perms check avoids exposing the mux socket cross-user.
    const st = lstatSync(dir)
    return st.isDirectory() && st.uid === uid && (st.mode & 0o77) === 0
  } catch {
    return false
  }
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
