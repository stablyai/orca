import { ipcRenderer } from 'electron'
import type {
  AgentStatusCacheIdentity,
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../../shared/agent-interrupt-intent'
import type { AgentQuestionAnsweredInferenceRequest } from '../../shared/agent-question-answered-intent'
import type { PreloadApi } from '../api-types'

export const agentStatusApi = {
  /** Listen for agent status updates forwarded from native hook receivers. */
  onSet: (callback: (data: AgentStatusIpcPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AgentStatusIpcPayload) =>
      callback(data)
    ipcRenderer.on('agentStatus:set', listener)
    return () => ipcRenderer.removeListener('agentStatus:set', listener)
  },
  onClear: (callback: (data: AgentStatusClearIpcPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AgentStatusClearIpcPayload) =>
      callback(data)
    ipcRenderer.on('agentStatus:clear', listener)
    return () => ipcRenderer.removeListener('agentStatus:clear', listener)
  },
  /** Pull cached hook statuses after renderer hydration, so startup replays aren't lost before tabs exist. */
  getSnapshot: (): Promise<AgentStatusIpcPayload[]> =>
    ipcRenderer.invoke('agentStatus:getSnapshot'),
  inferInterrupt: (request: AgentInterruptInferenceRequest): Promise<boolean> =>
    ipcRenderer.invoke('agentStatus:inferInterrupt', request),
  inferQuestionAnswered: (request: AgentQuestionAnsweredInferenceRequest): Promise<boolean> =>
    ipcRenderer.invoke('agentStatus:inferQuestionAnswered', request),
  onMigrationUnsupported: (
    callback: (entry: MigrationUnsupportedPtyEntry) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: MigrationUnsupportedPtyEntry) =>
      callback(entry)
    ipcRenderer.on('agentStatus:migrationUnsupported', listener)
    return () => ipcRenderer.removeListener('agentStatus:migrationUnsupported', listener)
  },
  onMigrationUnsupportedClear: (callback: (data: { ptyId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { ptyId: string }) => callback(data)
    ipcRenderer.on('agentStatus:migrationUnsupportedClear', listener)
    return () => ipcRenderer.removeListener('agentStatus:migrationUnsupportedClear', listener)
  },
  onLegacyWorkerTerminalRecovery: (
    callback: (data: {
      paneKey: string
      resolution: 'adopted' | 'exited' | 'rolled_back'
      ptyId?: string
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        paneKey: string
        resolution: 'adopted' | 'exited' | 'rolled_back'
        ptyId?: string
      }
    ) => callback(data)
    ipcRenderer.on('agentStatus:legacyWorkerTerminalRecovery', listener)
    return () => ipcRenderer.removeListener('agentStatus:legacyWorkerTerminalRecovery', listener)
  },
  getMigrationUnsupportedSnapshot: (): Promise<MigrationUnsupportedPtyEntry[]> =>
    ipcRenderer.invoke('agentStatus:getMigrationUnsupportedSnapshot'),
  /** Drop the cached hook status for a paneKey on both sides (memory + on-disk) so a relaunch can't resurrect a dismissed row. */
  drop: (paneKey: string): void => {
    ipcRenderer.send('agentStatus:drop', paneKey)
  },
  dropPersisted: (identity: AgentStatusCacheIdentity): void => {
    ipcRenderer.send('agentStatus:dropPersisted', identity)
  },
  dropPersistedBatch: (identities: readonly AgentStatusCacheIdentity[]): void => {
    ipcRenderer.send('agentStatus:dropPersistedBatch', identities)
  },
  reconcileEndedProcess: (paneKey: string): void => {
    ipcRenderer.send('agentStatus:reconcileEndedProcess', paneKey)
  },
  /** Drop all cached hook statuses under one terminal tab prefix; fired on explicit tab close even without a local row. */
  dropByTabPrefix: (tabId: string): void => {
    ipcRenderer.send('agentStatus:dropByTabPrefix', tabId)
  },
  retirePaneAuthority: (paneKey: string): void => {
    ipcRenderer.send('agentStatus:retirePaneAuthority', paneKey)
  },
  restorePaneAuthority: (paneKey: string): void => {
    ipcRenderer.send('agentStatus:restorePaneAuthority', paneKey)
  },
  transferPaneAuthority: (args: {
    fromPaneKey: string
    toPaneKey: string
    ptyId?: string
  }): void => {
    ipcRenderer.send('agentStatus:transferPaneAuthority', args)
  }
} satisfies PreloadApi['agentStatus']
