import type { RpcMethod } from '../core'
import { defineMethod } from '../core'
import {
  AbortDownload,
  AbortUpload,
  AppendUploadChunk,
  BoardId,
  CardComment,
  CardId,
  CommitUpload,
  Connect,
  CreateCard,
  ImageUrl,
  ListCards,
  ReadDownloadChunk,
  SearchCards,
  StartDownload,
  StartUpload,
  UpdateCard,
  UploadAttachment
} from './trello-method-schemas'
import {
  appendTrelloUploadSessionChunk,
  deleteTrelloDownloadSession,
  deleteTrelloUploadSession,
  getCommittedTrelloUpload,
  pruneExpiredDownloadSessions,
  readTrelloDownloadSessionChunk,
  startTrelloDownloadSession,
  startTrelloUploadSession
} from './trello-transfer-sessions'

export const TRELLO_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'trello.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.trelloConnect({
        apiKey: params.apiKey.trim(),
        token: params.token.trim()
      })
  }),
  defineMethod({
    name: 'trello.disconnect',
    params: null,
    handler: async (_params, { runtime }) => runtime.trelloDisconnect()
  }),
  defineMethod({
    name: 'trello.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.trelloStatus()
  }),
  defineMethod({
    name: 'trello.testConnection',
    params: null,
    handler: async (_params, { runtime }) => runtime.trelloTestConnection()
  }),
  defineMethod({
    name: 'trello.listBoards',
    params: null,
    handler: async (_params, { runtime }) => runtime.trelloListBoards()
  }),
  defineMethod({
    name: 'trello.listLists',
    params: BoardId,
    handler: async (params, { runtime }) => runtime.trelloListLists(params.boardId.trim())
  }),
  defineMethod({
    name: 'trello.listBoardMembers',
    params: BoardId,
    handler: async (params, { runtime }) => runtime.trelloListBoardMembers(params.boardId.trim())
  }),
  defineMethod({
    name: 'trello.listBoardLabels',
    params: BoardId,
    handler: async (params, { runtime }) => runtime.trelloListBoardLabels(params.boardId.trim())
  }),
  defineMethod({
    name: 'trello.listCards',
    params: ListCards,
    handler: async (params, { runtime }) =>
      runtime.trelloListCards(params?.filter, params?.limit, params?.boardIds)
  }),
  defineMethod({
    name: 'trello.searchCards',
    params: SearchCards,
    handler: async (params, { runtime }) =>
      runtime.trelloSearchCards(params.query, params.limit, params.boardIds)
  }),
  defineMethod({
    name: 'trello.getCard',
    params: CardId,
    handler: async (params, { runtime }) => runtime.trelloGetCard(params.cardId.trim())
  }),
  defineMethod({
    name: 'trello.createCard',
    params: CreateCard,
    handler: async (params, { runtime }) =>
      runtime.trelloCreateCard({
        idBoard: params.idBoard.trim(),
        idList: params.idList.trim(),
        name: params.name.trim(),
        desc: params.desc?.trim() || undefined
      })
  }),
  defineMethod({
    name: 'trello.updateCard',
    params: UpdateCard,
    handler: async (params, { runtime }) =>
      runtime.trelloUpdateCard(params.cardId.trim(), params.updates)
  }),
  defineMethod({
    name: 'trello.addCardComment',
    params: CardComment,
    handler: async (params, { runtime }) =>
      runtime.trelloAddCardComment(params.cardId.trim(), params.text.trim())
  }),
  defineMethod({
    name: 'trello.cardComments',
    params: CardId,
    handler: async (params, { runtime }) => runtime.trelloCardComments(params.cardId.trim())
  }),
  defineMethod({
    name: 'trello.uploadAttachment',
    params: UploadAttachment,
    handler: async (params, { runtime }) =>
      runtime.trelloUploadAttachment({
        cardId: params.cardId.trim(),
        name: params.name.trim(),
        mimeType: params.mimeType,
        contentBase64: params.contentBase64
      })
  }),
  defineMethod({
    name: 'trello.downloadImage',
    params: ImageUrl,
    handler: async (params, { runtime }) => runtime.trelloDownloadImage(params.url.trim())
  }),
  // ── Chunked upload transfer ──
  defineMethod({
    name: 'trello.startUpload',
    params: StartUpload,
    handler: (params) =>
      startTrelloUploadSession({
        cardId: params.cardId,
        name: params.name,
        mimeType: params.mimeType,
        expectedBase64Length: params.expectedBase64Length
      })
  }),
  defineMethod({
    name: 'trello.appendUploadChunk',
    params: AppendUploadChunk,
    handler: (params) => appendTrelloUploadSessionChunk(params)
  }),
  defineMethod({
    name: 'trello.commitUpload',
    params: CommitUpload,
    handler: async (params, { runtime }) => {
      try {
        return await runtime.trelloUploadAttachment(getCommittedTrelloUpload(params.uploadId))
      } finally {
        deleteTrelloUploadSession(params.uploadId)
      }
    }
  }),
  defineMethod({
    name: 'trello.abortUpload',
    params: AbortUpload,
    handler: (params) => {
      deleteTrelloUploadSession(params.uploadId)
      return { aborted: true }
    }
  }),
  // ── Chunked download transfer ──
  defineMethod({
    name: 'trello.startDownload',
    params: StartDownload,
    handler: async (params, { runtime }) => {
      pruneExpiredDownloadSessions()
      const result = await runtime.trelloDownloadImage(params.url)
      if (!result.ok) {
        throw new Error(result.error)
      }
      return startTrelloDownloadSession(result)
    }
  }),
  defineMethod({
    name: 'trello.readDownloadChunk',
    params: ReadDownloadChunk,
    handler: (params) => readTrelloDownloadSessionChunk(params)
  }),
  defineMethod({
    name: 'trello.abortDownload',
    params: AbortDownload,
    handler: (params) => {
      deleteTrelloDownloadSession(params.downloadId)
      return { aborted: true }
    }
  })
]

export { resetTrelloTransferSessionsForTest } from './trello-transfer-sessions'
