import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'

export function remoteOrcaManagedCodexHome(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): string {
  return joinRemotePath(
    hostPlatform,
    remoteOrcaUserDataPath(remoteHome, hostPlatform),
    'codex-runtime-home',
    'home'
  )
}

function remoteOrcaUserDataPath(remoteHome: string, hostPlatform: RemoteHostPlatform): string {
  if (hostPlatform.os === 'darwin') {
    return joinRemotePath(hostPlatform, remoteHome, 'Library', 'Application Support', 'orca')
  }
  if (hostPlatform.os === 'win32') {
    return joinRemotePath(hostPlatform, remoteHome, 'AppData', 'Roaming', 'orca')
  }
  return joinRemotePath(hostPlatform, remoteHome, '.config', 'orca')
}
