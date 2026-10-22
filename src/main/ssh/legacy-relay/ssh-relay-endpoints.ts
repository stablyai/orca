import { createHash } from 'node:crypto'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../ssh-remote-platform'

function relayEndpointForHost(
  hostPlatform: RemoteHostPlatform,
  remoteDir: string,
  sockName: string
): string {
  if (!isWindowsRemoteHost(hostPlatform)) {
    return joinRemotePath(hostPlatform, remoteDir, sockName)
  }
  const endpointHash = createHash('sha256')
    .update(`${remoteDir}\0${sockName}`)
    .digest('hex')
    .slice(0, 20)
  return `\\\\.\\pipe\\orca-relay-${endpointHash}`
}

export function windowsRelayPipePathsForSocketName(
  hostPlatform: RemoteHostPlatform,
  remoteDir: string,
  sockName: string
): string[] {
  return [
    relayEndpointForHost(hostPlatform, remoteDir, sockName),
    relayEndpointForHost(hostPlatform, remoteDir, `${sockName}-fallback`)
  ]
}
