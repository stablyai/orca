import { ipcRenderer } from 'electron'
import type {
  PreflightCheckOptions,
  PreflightRuntimeContext,
  PreflightStatus,
  RefreshAgentsResult
} from './preflight-api'
import type { PreloadApi } from '../../api-types'
import type { ZCodeInteractiveCapability } from '../../../shared/agent-launch/installation/zcode-missing-tui'

export const preflightApi = {
  check: (args?: PreflightCheckOptions): Promise<PreflightStatus> =>
    ipcRenderer.invoke('preflight:check', args),
  detectAgents: (
    args?: PreflightRuntimeContext & {
      enabledOnly?: boolean
      wakeWslDistro?: boolean
      userInitiated?: boolean
    }
  ): Promise<string[]> => ipcRenderer.invoke('preflight:detectAgents', args),
  onWslDistroRunning: (callback: (distro: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, distro: string): void => callback(distro)
    ipcRenderer.on('preflight:wslDistroRunning', listener)
    return () => ipcRenderer.removeListener('preflight:wslDistroRunning', listener)
  },
  zcodeInteractiveCapability: (): Promise<ZCodeInteractiveCapability> =>
    ipcRenderer.invoke('preflight:zcodeInteractiveCapability'),
  refreshAgents: (
    args?: PreflightRuntimeContext & {
      enabledOnly?: boolean
      wakeWslDistro?: boolean
      userInitiated?: boolean
    }
  ): Promise<RefreshAgentsResult> => ipcRenderer.invoke('preflight:refreshAgents', args),
  detectRemoteAgents: (args: { connectionId: string }): Promise<string[]> =>
    ipcRenderer.invoke('preflight:detectRemoteAgents', args),
  detectRemoteWindowsTerminalCapabilities: (args: {
    connectionId: string
  }): Promise<{
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }> => ipcRenderer.invoke('preflight:detectRemoteWindowsTerminalCapabilities', args)
} satisfies PreloadApi['preflight']
