import { ipcRenderer } from 'electron'
import type { PreflightRuntimeContext, PreloadApi, RefreshAgentsResult } from '../api-types'

export const preflightApi = {
  check: (args?: {
    force?: boolean
  }): Promise<{
    git: { installed: boolean }
    gh: { installed: boolean; authenticated: boolean }
    glab?: { installed: boolean; authenticated: boolean }
    bitbucket?: { configured: boolean; authenticated: boolean; account: string | null }
    azureDevOps?: {
      configured: boolean
      authenticated: boolean
      account: string | null
      baseUrl: string | null
      tokenConfigured: boolean
    }
    gitea?: {
      configured: boolean
      authenticated: boolean
      account: string | null
      baseUrl: string | null
      tokenConfigured: boolean
    }
    linear: { connected: boolean }
  }> => ipcRenderer.invoke('preflight:check', args),
  detectAgents: (args?: PreflightRuntimeContext): Promise<string[]> =>
    ipcRenderer.invoke('preflight:detectAgents', args),
  refreshAgents: (args?: PreflightRuntimeContext): Promise<RefreshAgentsResult> =>
    ipcRenderer.invoke('preflight:refreshAgents', args),
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
