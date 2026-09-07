import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

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

  status: () => ipcRenderer.invoke('bitbucket:status')
} satisfies PreloadApi['bitbucket']
