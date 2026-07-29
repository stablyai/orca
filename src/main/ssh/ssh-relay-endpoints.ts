import { createHash } from 'node:crypto'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  remoteBasename,
  type RemoteHostPlatform
} from './ssh-remote-platform'

export const WINDOWS_ACTIVE_PIPE_MARKER_PREFIX = '.windows-active-pipe-'

export function relayEndpointForHost(
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

export function relayHookEndpointDirForHost(
  hostPlatform: RemoteHostPlatform,
  remoteDir: string,
  sockPath: string
): string {
  return joinRemotePath(
    hostPlatform,
    remoteDir,
    'agent-hooks',
    remoteBasename(sockPath, hostPlatform)
  )
}

export function windowsRelayFallbackSocketName(sockName: string): string {
  return `${sockName}-fallback`
}

export function windowsRelayPipePathsForSocketName(
  hostPlatform: RemoteHostPlatform,
  remoteDir: string,
  sockName: string
): string[] {
  return [
    relayEndpointForHost(hostPlatform, remoteDir, sockName),
    relayEndpointForHost(hostPlatform, remoteDir, windowsRelayFallbackSocketName(sockName))
  ]
}

export function windowsActivePipeMarkerPath(
  hostPlatform: RemoteHostPlatform,
  remoteDir: string,
  sockName: string
): string {
  return joinRemotePath(
    hostPlatform,
    remoteDir,
    `${WINDOWS_ACTIVE_PIPE_MARKER_PREFIX}${sockName.replace(/[^a-zA-Z0-9.-]/g, '_')}`
  )
}

export function isWindowsRelayPipePath(value: string): boolean {
  return /^\\\\[.?]\\pipe\\orca-relay-[0-9a-f]{20}$/i.test(value)
}
