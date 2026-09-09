import { ipcRenderer } from 'electron'
import type {
  SshConnectionState,
  SshConfigHostListArgs,
  SshConfigHostListResult,
  SshConfigHostResolution,
  SshConfigImportResult,
  SshTargetAddResult,
  SshTargetCreateInput,
  SshTarget,
  SshTargetUpdateInput,
  SshTerminateSessionsResult,
  PortForwardEntry,
  EnrichedDetectedPort
} from '../../shared/ssh-types'
import {
  admitSshConnectionStateForAuthorityReconciliation,
  admitSshDetectedPorts
} from '../../shared/ssh-retained-payload-admission'
import type { FilesystemPathFlavor } from '../../shared/filesystem-entry-types'
import type { PreloadApi } from '../api-types'

export const sshApi = {
  listTargets: (): Promise<SshTarget[]> => ipcRenderer.invoke('ssh:listTargets'),

  listRemovedTargetLabels: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke('ssh:listRemovedTargetLabels'),

  addTarget: (args: { target: SshTargetCreateInput }): Promise<SshTargetAddResult> =>
    ipcRenderer.invoke('ssh:addTarget', args),

  updateTarget: (args: { id: string; updates: SshTargetUpdateInput }): Promise<SshTarget> =>
    ipcRenderer.invoke('ssh:updateTarget', args),

  removeTarget: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke('ssh:removeTarget', args),

  importConfig: (args?: { reAdopt?: boolean }): Promise<SshConfigImportResult> =>
    ipcRenderer.invoke('ssh:importConfig', args),

  listConfigHosts: (args?: SshConfigHostListArgs): Promise<SshConfigHostListResult> =>
    ipcRenderer.invoke('ssh:listConfigHosts', args),

  resolveConfigHost: (args: { alias: string }): Promise<SshConfigHostResolution | null> =>
    ipcRenderer.invoke('ssh:resolveConfigHost', args),

  connect: async (args: { targetId: string }): Promise<SshConnectionState | null> => {
    const state: unknown = await ipcRenderer.invoke('ssh:connect', args)
    return state ? admitSshConnectionStateForAuthorityReconciliation(state, args.targetId) : null
  },

  disconnect: (args: { targetId: string }): Promise<void> =>
    ipcRenderer.invoke('ssh:disconnect', args),

  terminateSessions: (args: { targetId: string }): Promise<SshTerminateSessionsResult> =>
    ipcRenderer.invoke('ssh:terminateSessions', args),

  resetRelay: (args: { targetId: string }): Promise<void> =>
    ipcRenderer.invoke('ssh:resetRelay', args),

  getState: async (args: { targetId: string }): Promise<SshConnectionState | null> => {
    const state: unknown = await ipcRenderer.invoke('ssh:getState', args)
    return state ? admitSshConnectionStateForAuthorityReconciliation(state, args.targetId) : null
  },

  needsPassphrasePrompt: (args: { targetId: string }): Promise<boolean> =>
    ipcRenderer.invoke('ssh:needsPassphrasePrompt', args),

  testConnection: async (args: {
    targetId: string
  }): Promise<{ success: boolean; error?: string; state?: SshConnectionState }> => {
    const result: { success: boolean; error?: string; state?: unknown } = await ipcRenderer.invoke(
      'ssh:testConnection',
      args
    )
    const state = result.state
      ? admitSshConnectionStateForAuthorityReconciliation(result.state, args.targetId)
      : null
    return { ...result, ...(state ? { state } : { state: undefined }) }
  },

  onStateChanged: (
    callback: (data: { targetId: string; state: SshConnectionState }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { targetId: string; state: unknown }
    ): void => {
      const state = admitSshConnectionStateForAuthorityReconciliation(data.state, data.targetId)
      if (state) {
        callback({ targetId: data.targetId, state })
      }
    }
    ipcRenderer.on('ssh:state-changed', listener)
    return () => ipcRenderer.removeListener('ssh:state-changed', listener)
  },

  addPortForward: (args: {
    targetId: string
    localPort: number
    remoteHost: string
    remotePort: number
    label?: string
  }): Promise<PortForwardEntry> => ipcRenderer.invoke('ssh:addPortForward', args),

  updatePortForward: (args: {
    id: string
    targetId: string
    localPort: number
    remoteHost: string
    remotePort: number
    label?: string
  }): Promise<PortForwardEntry> => ipcRenderer.invoke('ssh:updatePortForward', args),

  removePortForward: (args: { id: string }): Promise<PortForwardEntry | null> =>
    ipcRenderer.invoke('ssh:removePortForward', args),

  listPortForwards: (args?: { targetId?: string }): Promise<PortForwardEntry[]> =>
    ipcRenderer.invoke('ssh:listPortForwards', args),

  listDetectedPorts: async (args: { targetId: string }): Promise<EnrichedDetectedPort[]> =>
    admitSshDetectedPorts(await ipcRenderer.invoke('ssh:listDetectedPorts', args)),

  onPortForwardsChanged: (
    callback: (data: { targetId: string; forwards: PortForwardEntry[] }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { targetId: string; forwards: PortForwardEntry[] }
    ) => callback(data)
    ipcRenderer.on('ssh:port-forwards-changed', handler)
    return () => ipcRenderer.removeListener('ssh:port-forwards-changed', handler)
  },

  onDetectedPortsChanged: (
    callback: (data: { targetId: string; ports: EnrichedDetectedPort[] }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { targetId: string; ports: unknown }
    ) => callback({ targetId: data.targetId, ports: admitSshDetectedPorts(data.ports) })
    ipcRenderer.on('ssh:detected-ports-changed', handler)
    return () => ipcRenderer.removeListener('ssh:detected-ports-changed', handler)
  },

  browseDir: (args: {
    targetId: string
    dirPath: string
  }): Promise<{
    entries: { name: string; isDirectory: boolean }[]
    resolvedPath: string
    pathFlavor: FilesystemPathFlavor
  }> => ipcRenderer.invoke('ssh:browseDir', args),

  onCredentialRequest: (
    callback: (data: {
      requestId: string
      targetId: string
      kind: 'passphrase' | 'password' | 'keyboard-interactive'
      detail: string
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        requestId: string
        targetId: string
        kind: 'passphrase' | 'password' | 'keyboard-interactive'
        detail: string
      }
    ) => callback(data)
    ipcRenderer.on('ssh:credential-request', listener)
    return () => ipcRenderer.removeListener('ssh:credential-request', listener)
  },

  onCredentialResolved: (callback: (data: { requestId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string }) =>
      callback(data)
    ipcRenderer.on('ssh:credential-resolved', listener)
    return () => ipcRenderer.removeListener('ssh:credential-resolved', listener)
  },

  submitCredential: (args: { requestId: string; value: string | null }): Promise<void> =>
    ipcRenderer.invoke('ssh:submitCredential', args)
} satisfies PreloadApi['ssh']
