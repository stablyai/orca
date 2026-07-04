import { getActiveMultiplexer } from './ssh'
import type { WindowsPowerShellResolutionDiagnostic } from '../../shared/windows-powershell-executable'

export type RemoteWindowsTerminalCapabilities = {
  wslAvailable: boolean
  wslDistros: string[]
  pwshAvailable: boolean
  pwshDiagnostic: WindowsPowerShellResolutionDiagnostic | null
  gitBashAvailable: boolean
  hostPlatform: NodeJS.Platform | null
}

const EMPTY_REMOTE_WINDOWS_TERMINAL_CAPABILITIES: RemoteWindowsTerminalCapabilities = {
  wslAvailable: false,
  wslDistros: [],
  pwshAvailable: false,
  pwshDiagnostic: null,
  gitBashAvailable: false,
  hostPlatform: null
}

export async function detectRemoteWindowsTerminalCapabilities(args: {
  connectionId: string
}): Promise<RemoteWindowsTerminalCapabilities> {
  const mux = getActiveMultiplexer(args.connectionId)
  if (!mux || mux.isDisposed()) {
    return EMPTY_REMOTE_WINDOWS_TERMINAL_CAPABILITIES
  }
  const result = (await mux.request('preflight.detectWindowsTerminalCapabilities', {})) as
    | (Omit<RemoteWindowsTerminalCapabilities, 'pwshDiagnostic'> & {
        pwshDiagnostic?: WindowsPowerShellResolutionDiagnostic | null
      })
    | undefined
  return result
    ? { ...result, pwshDiagnostic: result.pwshDiagnostic ?? null }
    : EMPTY_REMOTE_WINDOWS_TERMINAL_CAPABILITIES
}
