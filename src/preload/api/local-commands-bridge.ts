import { ipcRenderer } from 'electron'
import {
  LOCAL_COMMANDS_PROMPTS_CHANNEL,
  LOCAL_COMMANDS_STATE_CHANNEL,
  type LocalCommandAuditEntry,
  type LocalCommandDecision,
  type LocalCommandPrompt,
  type LocalCommandSetEnabledRequest,
  type LocalCommandsState
} from '../../shared/local-commands/local-command-desktop-types'

/** Desktop only: commands that agents in cloud workspaces ask to run on this computer. */
export type LocalCommandsApi = {
  getState: () => Promise<LocalCommandsState>
  setEnabled: (request: LocalCommandSetEnabledRequest) => Promise<{ ok: boolean; error?: string }>
  removeRule: (id: string) => Promise<boolean>
  listAudit: (limit?: number) => Promise<LocalCommandAuditEntry[]>
  getPrompts: () => Promise<LocalCommandPrompt[]>
  /** Answers by id only: main runs what it holds, never anything the window sends. */
  decide: (id: string, decision: LocalCommandDecision) => Promise<{ ok: boolean; error?: string }>
  onPrompts: (callback: (prompts: LocalCommandPrompt[]) => void) => () => void
  onStateChanged: (callback: () => void) => () => void
}

export const localCommandsApi: LocalCommandsApi = {
  getState: () => ipcRenderer.invoke('localCommands:getState'),
  setEnabled: (request) => ipcRenderer.invoke('localCommands:setEnabled', request),
  removeRule: (id) => ipcRenderer.invoke('localCommands:removeRule', id),
  listAudit: (limit) => ipcRenderer.invoke('localCommands:listAudit', limit),
  getPrompts: () => ipcRenderer.invoke('localCommands:getPrompts'),
  decide: (id, decision) => ipcRenderer.invoke('localCommands:decide', { id, decision }),
  onPrompts: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, prompts: LocalCommandPrompt[]): void =>
      callback(prompts)
    ipcRenderer.on(LOCAL_COMMANDS_PROMPTS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(LOCAL_COMMANDS_PROMPTS_CHANNEL, listener)
  },
  onStateChanged: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(LOCAL_COMMANDS_STATE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(LOCAL_COMMANDS_STATE_CHANNEL, listener)
  }
}
