import { ipcRenderer } from 'electron'
import type { HostAgentSignInAgent } from '../../shared/host-agent-sign-in-status'
import type {
  SshAgentSignInFlow,
  SshAgentSignInStatusResult
} from '../../shared/ssh-agent-sign-in-types'

/** Classic SSH hosts: verdicts, sign-in links and flow phases only; the pasted code goes in once. */
export type SshAgentSignInApi = {
  status: (request: { targetId: string; force?: boolean }) => Promise<SshAgentSignInStatusResult>
  start: (request: {
    targetId: string
    agent: HostAgentSignInAgent
  }) => Promise<SshAgentSignInFlow | null>
  submitCode: (request: { flowId: string; code: string }) => Promise<boolean>
  cancel: (request: { flowId: string }) => Promise<void>
  flows: (request: { targetId: string }) => Promise<SshAgentSignInFlow[]>
  signOut: (request: {
    targetId: string
    agent: HostAgentSignInAgent
  }) => Promise<SshAgentSignInStatusResult>
  onFlowChanged: (listener: (flow: SshAgentSignInFlow) => void) => () => void
}

export const sshAgentSignInApi: SshAgentSignInApi = {
  status: (request) => ipcRenderer.invoke('sshAgentSignIn:status', request),
  start: (request) => ipcRenderer.invoke('sshAgentSignIn:start', request),
  submitCode: (request) => ipcRenderer.invoke('sshAgentSignIn:submitCode', request),
  cancel: (request) => ipcRenderer.invoke('sshAgentSignIn:cancel', request),
  flows: (request) => ipcRenderer.invoke('sshAgentSignIn:flows', request),
  signOut: (request) => ipcRenderer.invoke('sshAgentSignIn:signOut', request),
  onFlowChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, flow: SshAgentSignInFlow): void =>
      listener(flow)
    ipcRenderer.on('sshAgentSignIn:flowChanged', handler)
    return () => ipcRenderer.removeListener('sshAgentSignIn:flowChanged', handler)
  }
}
