import { ipcRenderer } from 'electron'
import type {
  CodexRateLimitResetResult,
  RateLimitRuntimeTarget,
  RateLimitState
} from '../../shared/rate-limit-types'
import type { PreloadApi } from '../api-types'

export const rateLimitsApi = {
  get: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:get'),
  refresh: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refresh'),
  refreshCodexForTarget: (target: RateLimitRuntimeTarget): Promise<RateLimitState> =>
    ipcRenderer.invoke('rateLimits:refreshCodexForTarget', target),
  consumeCodexResetCredit: (): Promise<CodexRateLimitResetResult> =>
    ipcRenderer.invoke('rateLimits:consumeCodexResetCredit'),
  refreshClaudeForTarget: (target: RateLimitRuntimeTarget): Promise<RateLimitState> =>
    ipcRenderer.invoke('rateLimits:refreshClaudeForTarget', target),
  setPollingInterval: (ms: number): Promise<void> =>
    ipcRenderer.invoke('rateLimits:setPollingInterval', ms),
  fetchInactiveClaudeAccounts: (): Promise<void> =>
    ipcRenderer.invoke('rateLimits:fetchInactiveClaudeAccounts'),
  fetchInactiveCodexAccounts: (): Promise<void> =>
    ipcRenderer.invoke('rateLimits:fetchInactiveCodexAccounts'),
  refreshMiniMax: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refreshMiniMax'),
  refreshGrok: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refreshGrok'),
  onUpdate: (callback: (state: RateLimitState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: RateLimitState) => callback(state)
    ipcRenderer.on('rateLimits:update', listener)
    return () => ipcRenderer.removeListener('rateLimits:update', listener)
  }
} satisfies PreloadApi['rateLimits']
