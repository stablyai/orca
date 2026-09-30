import type { SshTarget } from '../../shared/ssh-types'

// Why its own module: auth, forwarding intent and ControlMaster keying all need it, and importing
// it from system-ssh-args would close a cycle through ssh-control-socket.
export function isOpenSshConfigBackedTarget(
  target: Pick<SshTarget, 'source' | 'configHost' | 'host'>
): boolean {
  if (target.source === 'ssh-config') {
    return true
  }
  if (target.source === 'manual') {
    return false
  }
  // Why: legacy imported aliases have a distinct configHost; manual targets
  // historically stored configHost=host and still need explicit -p/-i args.
  return Boolean(target.configHost && target.configHost !== target.host)
}
