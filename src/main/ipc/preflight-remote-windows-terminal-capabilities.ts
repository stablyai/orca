import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

export type RemoteWindowsTerminalCapabilities = {
  wslAvailable: boolean
  wslDistros: string[]
  pwshAvailable: boolean
  gitBashAvailable: boolean
  // Why optional: relays predating Cmder omit it, which means no Cmder.
  cmderAvailable?: boolean
  hostPlatform: NodeJS.Platform | null
}

export async function detectRemoteWindowsTerminalCapabilities(args: {
  connectionId: string
}): Promise<RemoteWindowsTerminalCapabilities> {
  throw new SshHostNotServedError(args.connectionId)
}
