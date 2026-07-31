import { userInfo } from 'node:os'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'
import { isOpenSshConfigBackedTarget } from './system-ssh-args'

const DEFAULT_SSH_PORT = 22

type HostBlockMatchTarget = Pick<SshTarget, 'source' | 'configHost' | 'host' | 'label'>

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

// Why: `ssh -G` fills `user` from the local account whenever no User directive
// matched; null means the local account is unknown, so `user` carries no verdict.
function localAccountName(): string | null {
  const fromEnv = normalize(process.env.USER || process.env.LOGNAME || process.env.USERNAME)
  if (fromEnv) {
    return fromEnv
  }
  try {
    return normalize(userInfo().username) || null
  } catch {
    return null
  }
}

/**
 * Whether `ssh -G <alias>` output carries evidence that an ssh_config Host block
 * for this alias actually applied.
 *
 * Why: `ssh -G` exits 0 for an alias with no matching block and prints a fully
 * populated *default* config (hostname = the alias itself, user = the local
 * account, port 22, no proxy). Treating any non-null resolution as authoritative
 * would silently replace a stored target's host/port/user/proxy/identity with
 * those defaults — dialing the bare alias as the local user — whenever the block
 * is renamed, removed, or lives on another machine.
 *
 * Known limitation: the signals below read the *effective* config, so a wildcard
 * `Host *` supplying User/Port/ProxyCommand — or `CanonicalizeHostname yes` —
 * still reads as a match for an alias whose own block is gone. The reverse
 * verdict falls back to the stored snapshot, whose IdentityFile is used verbatim
 * (only `~` is expanded), so a stored path with OpenSSH tokens (%d/%h/%r) stays
 * unreadable — pre-existing behaviour, unchanged here.
 */
export function hasOpenSshHostBlockMatch(
  target: HostBlockMatchTarget,
  resolved: SshResolvedConfig | null | undefined
): boolean {
  if (!isOpenSshConfigBackedTarget(target) || !resolved) {
    return false
  }
  // Why: an echoed hostname is the only field OpenSSH always emits, so an empty
  // one means the resolution never went through `ssh -G` (keep it authoritative).
  const hostname = normalize(resolved.hostname)
  if (!hostname || hostname !== normalize(target.configHost || target.label)) {
    return true
  }
  if (resolved.port && resolved.port !== DEFAULT_SSH_PORT) {
    return true
  }
  if (resolved.proxyCommand || resolved.proxyJump) {
    return true
  }
  const localAccount = localAccountName()
  const user = normalize(resolved.user)
  return localAccount !== null && user !== '' && user !== localAccount
}
