import { ipcRenderer } from 'electron'
import type {
  CodexRateLimitResetResult,
  RateLimitRuntimeTarget,
  RateLimitState,
  RuntimeTargetUsageRead
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { PreloadApi } from '../../api-types'

export const rateLimitsApi = {
  get: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:get'),
  refresh: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refresh'),
  refreshOnOwnerReturn: (): Promise<void> => ipcRenderer.invoke('rateLimits:refreshOnOwnerReturn'),
  refreshCodexForTarget: (target: RateLimitRuntimeTarget): Promise<RateLimitState> =>
    ipcRenderer.invoke('rateLimits:refreshCodexForTarget', target),
  consumeCodexResetCredit: (): Promise<CodexRateLimitResetResult> =>
    ipcRenderer.invoke('rateLimits:consumeCodexResetCredit'),
  refreshClaudeForTarget: (target: RateLimitRuntimeTarget): Promise<RateLimitState> =>
    ipcRenderer.invoke('rateLimits:refreshClaudeForTarget', target),
  fetchInactiveClaudeAccounts: (): Promise<void> =>
    ipcRenderer.invoke('rateLimits:fetchInactiveClaudeAccounts'),
  fetchInactiveCodexAccounts: (): Promise<void> =>
    ipcRenderer.invoke('rateLimits:fetchInactiveCodexAccounts'),
  refreshGrok: (): Promise<RateLimitState> => ipcRenderer.invoke('rateLimits:refreshGrok'),
  readUsageForRuntimeTarget: (
    target: RateLimitRuntimeTarget
  ): Promise<RuntimeTargetUsageRead | null> =>
    ipcRenderer.invoke('rateLimits:readUsageForRuntimeTarget', target),
  onUpdate: (callback: (state: RateLimitState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: RateLimitState) => callback(state)
    ipcRenderer.on('rateLimits:update', listener)
    return () => ipcRenderer.removeListener('rateLimits:update', listener)
  }
} satisfies PreloadApi['rateLimits']
