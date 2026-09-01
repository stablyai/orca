import { ipcRenderer } from 'electron'

export const bitbucketApi = {
  connect: (args: {
    authMode: 'token' | 'basic'
    accessToken?: string | null
    email?: string | null
    apiToken?: string | null
    baseUrl?: string | null
  }): Promise<{ ok: true; account: string | null } | { ok: false; error: string }> =>
    ipcRenderer.invoke('bitbucket:connect', args),

  disconnect: (): Promise<void> => ipcRenderer.invoke('bitbucket:disconnect'),

  status: (): Promise<unknown> => ipcRenderer.invoke('bitbucket:status')
}
