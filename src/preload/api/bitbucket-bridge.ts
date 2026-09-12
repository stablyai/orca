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

  status: () => ipcRenderer.invoke('bitbucket:status'),

  mergePR: (args) => ipcRenderer.invoke('bitbucket:mergePR', args),

  closePR: (args) => ipcRenderer.invoke('bitbucket:closePR', args),

  getPRComments: (args) => ipcRenderer.invoke('bitbucket:getPRComments', args),

  addPRComment: (args) => ipcRenderer.invoke('bitbucket:addPRComment', args),

  replyPRComment: (args) => ipcRenderer.invoke('bitbucket:replyPRComment', args)
} satisfies PreloadApi['bitbucket']
