import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const businessmapApi = {
  connect: (args: {
    subdomain: string
    apiKey: string
    domain?: 'businessmap.io' | 'kanbanize.com'
  }) => ipcRenderer.invoke('businessmap:connect', args),

  disconnect: (args?: { siteId?: string }): Promise<void> =>
    ipcRenderer.invoke('businessmap:disconnect', args),

  selectSite: (args: { siteId: string }) => ipcRenderer.invoke('businessmap:selectSite', args),

  status: () => ipcRenderer.invoke('businessmap:status'),

  readStatus: () => ipcRenderer.invoke('businessmap:readStatus'),

  testConnection: (args?: { siteId?: string }) =>
    ipcRenderer.invoke('businessmap:testConnection', args),

  searchCards: (args: { query: string; limit?: number; siteId?: string; boardId?: number }) =>
    ipcRenderer.invoke('businessmap:searchCards', args),

  listCards: (args?: {
    filter?: 'assigned' | 'all' | 'done'
    limit?: number
    siteId?: string
    boardId?: number
  }) => ipcRenderer.invoke('businessmap:listCards', args),

  getCard: (args: { id: number; siteId?: string }) =>
    ipcRenderer.invoke('businessmap:getCard', args),

  createCard: (args: {
    boardId: number
    title: string
    description?: string
    columnId?: number
    laneId?: number
    siteId?: string
  }): Promise<{ ok: true; id: number; url: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('businessmap:createCard', args),

  updateCard: (args: {
    id: number
    updates: unknown
    siteId?: string
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('businessmap:updateCard', args),

  addCardComment: (args: {
    id: number
    body: string
    siteId?: string
  }): Promise<{ ok: true; id: number } | { ok: false; error: string }> =>
    ipcRenderer.invoke('businessmap:addCardComment', args),

  issueComments: (args: { id: number; siteId?: string }) =>
    ipcRenderer.invoke('businessmap:issueComments', args),

  listBoards: (args?: { siteId?: string }) => ipcRenderer.invoke('businessmap:listBoards', args),

  getBoardTree: (args: { boardId: number; siteId?: string }) =>
    ipcRenderer.invoke('businessmap:getBoardTree', args)
} satisfies PreloadApi['businessmap']
