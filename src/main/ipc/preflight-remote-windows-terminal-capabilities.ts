import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

export type RemoteWindowsTerminalCapabilities = {
  wslAvailable: boolean
  wslDistros: string[]
  pwshAvailable: boolean
  gitBashAvailable: boolean
  hostPlatform: NodeJS.Platform | null
}

export async function detectRemoteWindowsTerminalCapabilities(args: {
  connectionId: string
}): Promise<RemoteWindowsTerminalCapabilities> {
  throw new SshHostNotServedError(args.connectionId)
}
