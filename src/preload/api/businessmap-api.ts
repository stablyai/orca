import type {
  BusinessmapBoard,
  BusinessmapCard,
  BusinessmapCardFilter,
  BusinessmapCardUpdate,
  BusinessmapComment,
  BusinessmapConnectArgs,
  BusinessmapConnectionStatus,
  BusinessmapCreateCardArgs,
  BusinessmapCreateCardResult,
  BusinessmapMutationResult,
  BusinessmapViewer
} from '../../shared/businessmap-types'

export type BusinessmapApi = {
  connect: (
    args: BusinessmapConnectArgs
  ) => Promise<{ ok: true; viewer: BusinessmapViewer } | { ok: false; error: string }>
  disconnect: (args?: { siteId?: string }) => Promise<void>
  selectSite: (args: { siteId: string }) => Promise<BusinessmapConnectionStatus>
  status: () => Promise<BusinessmapConnectionStatus>
  readStatus: () => Promise<BusinessmapConnectionStatus>
  testConnection: (args?: {
    siteId?: string
  }) => Promise<{ ok: true; viewer: BusinessmapViewer } | { ok: false; error: string }>
  searchCards: (args: {
    query: string
    limit?: number
    siteId?: string
    boardId?: number
  }) => Promise<BusinessmapCard[]>
  listCards: (args?: {
    filter?: BusinessmapCardFilter
    limit?: number
    siteId?: string
    boardId?: number
  }) => Promise<BusinessmapCard[]>
  getCard: (args: { id: number; siteId?: string }) => Promise<BusinessmapCard | null>
  createCard: (
    args: BusinessmapCreateCardArgs & { siteId?: string }
  ) => Promise<BusinessmapCreateCardResult>
  updateCard: (args: {
    id: number
    updates: BusinessmapCardUpdate
    siteId?: string
  }) => Promise<BusinessmapMutationResult>
  addCardComment: (args: {
    id: number
    body: string
    siteId?: string
  }) => Promise<{ ok: true; id: number } | { ok: false; error: string }>
  issueComments: (args: { id: number; siteId?: string }) => Promise<BusinessmapComment[]>
  listBoards: (args?: { siteId?: string }) => Promise<BusinessmapBoard[]>
  getBoardTree: (args: { boardId: number; siteId?: string }) => Promise<unknown>
}
