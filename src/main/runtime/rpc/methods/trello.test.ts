import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { TRELLO_METHODS, resetTrelloTransferSessionsForTest } from './trello'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntimeMock(): OrcaRuntimeService {
  return {
    getRuntimeId: vi.fn(() => 'runtime-1'),
    trelloConnect: vi.fn(),
    trelloDisconnect: vi.fn(),
    trelloStatus: vi.fn(),
    trelloTestConnection: vi.fn(),
    trelloListBoards: vi.fn(),
    trelloListLists: vi.fn(),
    trelloListBoardMembers: vi.fn(),
    trelloListBoardLabels: vi.fn(),
    trelloListCards: vi.fn(),
    trelloSearchCards: vi.fn(),
    trelloGetCard: vi.fn(),
    trelloCreateCard: vi.fn(),
    trelloUpdateCard: vi.fn(),
    trelloAddCardComment: vi.fn(),
    trelloCardComments: vi.fn(),
    trelloUploadAttachment: vi.fn(),
    trelloDownloadImage: vi.fn()
  } as unknown as OrcaRuntimeService
}

describe('trello RPC methods', () => {
  beforeEach(() => {
    resetTrelloTransferSessionsForTest()
  })

  it('routes account, property metadata, card, comment, and image methods', async () => {
    const runtime = makeRuntimeMock()
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    await dispatcher.dispatch(makeRequest('trello.status'))
    await dispatcher.dispatch(makeRequest('trello.testConnection'))
    await dispatcher.dispatch(makeRequest('trello.connect', { apiKey: ' key ', token: ' token ' }))
    await dispatcher.dispatch(makeRequest('trello.disconnect'))
    await dispatcher.dispatch(makeRequest('trello.listBoards'))
    await dispatcher.dispatch(makeRequest('trello.listLists', { boardId: ' board-1 ' }))
    await dispatcher.dispatch(makeRequest('trello.listBoardMembers', { boardId: ' board-1 ' }))
    await dispatcher.dispatch(makeRequest('trello.listBoardLabels', { boardId: ' board-1 ' }))
    await dispatcher.dispatch(
      makeRequest('trello.listCards', {
        filter: 'allOpen',
        limit: 50,
        boardIds: ['board-1']
      })
    )
    await dispatcher.dispatch(
      makeRequest('trello.searchCards', {
        query: ' card ',
        limit: 25,
        boardIds: ['board-1']
      })
    )
    await dispatcher.dispatch(makeRequest('trello.getCard', { cardId: ' card-1 ' }))
    await dispatcher.dispatch(
      makeRequest('trello.createCard', {
        idBoard: ' board-1 ',
        idList: ' list-1 ',
        name: ' New card ',
        desc: ' Description '
      })
    )
    await dispatcher.dispatch(
      makeRequest('trello.updateCard', {
        cardId: ' card-1 ',
        updates: { idList: 'list-2', idMembers: ['m-1'], idLabels: ['l-1'] }
      })
    )
    await dispatcher.dispatch(
      makeRequest('trello.addCardComment', { cardId: ' card-1 ', text: ' Looks good ' })
    )
    await dispatcher.dispatch(makeRequest('trello.cardComments', { cardId: ' card-1 ' }))
    await dispatcher.dispatch(
      makeRequest('trello.downloadImage', {
        url: ' https://trello.com/1/cards/card-1/attachments/a-1/download/image.png '
      })
    )

    expect(runtime.trelloStatus).toHaveBeenCalled()
    expect(runtime.trelloTestConnection).toHaveBeenCalled()
    expect(runtime.trelloConnect).toHaveBeenCalledWith({ apiKey: 'key', token: 'token' })
    expect(runtime.trelloDisconnect).toHaveBeenCalled()
    expect(runtime.trelloListBoards).toHaveBeenCalled()
    expect(runtime.trelloListLists).toHaveBeenCalledWith('board-1')
    expect(runtime.trelloListBoardMembers).toHaveBeenCalledWith('board-1')
    expect(runtime.trelloListBoardLabels).toHaveBeenCalledWith('board-1')
    expect(runtime.trelloListCards).toHaveBeenCalledWith('allOpen', 50, ['board-1'])
    expect(runtime.trelloSearchCards).toHaveBeenCalledWith(' card ', 25, ['board-1'])
    expect(runtime.trelloGetCard).toHaveBeenCalledWith('card-1')
    expect(runtime.trelloCreateCard).toHaveBeenCalledWith({
      idBoard: 'board-1',
      idList: 'list-1',
      name: 'New card',
      desc: 'Description'
    })
    expect(runtime.trelloUpdateCard).toHaveBeenCalledWith('card-1', {
      idList: 'list-2',
      idMembers: ['m-1'],
      idLabels: ['l-1']
    })
    expect(runtime.trelloAddCardComment).toHaveBeenCalledWith('card-1', 'Looks good')
    expect(runtime.trelloCardComments).toHaveBeenCalledWith('card-1')
    expect(runtime.trelloDownloadImage).toHaveBeenCalledWith(
      'https://trello.com/1/cards/card-1/attachments/a-1/download/image.png'
    )
  })

  it('passes empty desc to runtime as empty string', async () => {
    const runtime = makeRuntimeMock()
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    await dispatcher.dispatch(
      makeRequest('trello.updateCard', {
        cardId: 'card-1',
        updates: { desc: '' }
      })
    )

    expect(runtime.trelloUpdateCard).toHaveBeenCalledWith('card-1', { desc: '' })
  })

  it('rejects non-string desc values', async () => {
    const runtime = makeRuntimeMock()
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    const result = await dispatcher.dispatch(
      makeRequest('trello.updateCard', {
        cardId: 'card-1',
        updates: { desc: 123 }
      })
    )

    expect(result.ok).toBe(false)
    expect(runtime.trelloUpdateCard).not.toHaveBeenCalled()
  })

  it('rejects upload with unsupported MIME type', async () => {
    const runtime = makeRuntimeMock()
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    const result = await dispatcher.dispatch(
      makeRequest('trello.uploadAttachment', {
        cardId: 'card-1',
        name: 'test.svg',
        mimeType: 'image/svg+xml',
        contentBase64: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='
      })
    )

    expect(result.ok).toBe(false)
    expect(runtime.trelloUploadAttachment).not.toHaveBeenCalled()
  })

  it('rejects upload with malformed base64 content', async () => {
    const runtime = makeRuntimeMock()
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    const result = await dispatcher.dispatch(
      makeRequest('trello.uploadAttachment', {
        cardId: 'card-1',
        name: 'test.png',
        mimeType: 'image/png',
        contentBase64: 'not-valid-base64!!!'
      })
    )

    expect(result.ok).toBe(false)
    expect(runtime.trelloUploadAttachment).not.toHaveBeenCalled()
  })

  it('accepts upload with valid MIME and base64', async () => {
    const runtime = makeRuntimeMock()
    vi.mocked(runtime.trelloUploadAttachment).mockResolvedValue({
      ok: true,
      attachment: {
        id: 'att-1',
        name: 'test.png',
        fileName: 'test.png',
        mimeType: 'image/png',
        url: 'https://trello.com/att'
      }
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    const result = await dispatcher.dispatch(
      makeRequest('trello.uploadAttachment', {
        cardId: 'card-1',
        name: 'test.png',
        mimeType: 'image/png',
        contentBase64: 'iVBORw0KGgo='
      })
    )

    expect(result.ok).toBe(true)
    expect(runtime.trelloUploadAttachment).toHaveBeenCalledWith({
      cardId: 'card-1',
      name: 'test.png',
      mimeType: 'image/png',
      contentBase64: 'iVBORw0KGgo='
    })
  })

  it('chunked upload: start → append → commit calls runtime with assembled content', async () => {
    const runtime = makeRuntimeMock()
    vi.mocked(runtime.trelloUploadAttachment).mockResolvedValue({
      ok: true,
      attachment: {
        id: 'att-1',
        name: 'photo.jpg',
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        url: 'https://trello.com/att'
      }
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    const startResult = await dispatcher.dispatch(
      makeRequest('trello.startUpload', {
        cardId: 'card-1',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        expectedBase64Length: 8
      })
    )
    expect(startResult.ok).toBe(true)
    const uploadId = (startResult as { ok: true; result: { uploadId: string } }).result.uploadId

    await dispatcher.dispatch(
      makeRequest('trello.appendUploadChunk', {
        uploadId,
        offset: 0,
        contentBase64: 'AAAA'
      })
    )
    await dispatcher.dispatch(
      makeRequest('trello.appendUploadChunk', {
        uploadId,
        offset: 4,
        contentBase64: 'BBBB'
      })
    )

    const commitResult = await dispatcher.dispatch(makeRequest('trello.commitUpload', { uploadId }))
    expect(commitResult.ok).toBe(true)
    expect(runtime.trelloUploadAttachment).toHaveBeenCalledWith({
      cardId: 'card-1',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      contentBase64: 'AAAABBBB'
    })
  })

  it('chunked download: start returns metadata, chunks return slices', async () => {
    const runtime = makeRuntimeMock()
    const fullBase64 = 'AAAAAAAABBBBBBBB'
    vi.mocked(runtime.trelloDownloadImage).mockResolvedValue({
      ok: true,
      contentType: 'image/png',
      contentBase64: fullBase64
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    const startResult = await dispatcher.dispatch(
      makeRequest('trello.startDownload', {
        url: 'https://trello.com/image.png'
      })
    )
    expect(startResult.ok).toBe(true)
    const startData = (
      startResult as {
        ok: true
        result: {
          downloadId: string
          contentType: string
          totalBase64Length: number
          chunkSize: number
        }
      }
    ).result
    expect(startData.contentType).toBe('image/png')
    expect(startData.totalBase64Length).toBe(fullBase64.length)
    expect(startData.chunkSize).toBe(512 * 1024)
    // Verify full content is NOT embedded in start result
    expect(JSON.stringify(startData)).not.toContain(fullBase64)

    const chunk1 = await dispatcher.dispatch(
      makeRequest('trello.readDownloadChunk', {
        downloadId: startData.downloadId,
        offset: 0,
        length: 8
      })
    )
    expect(chunk1.ok).toBe(true)
    expect((chunk1 as { ok: true; result: { contentBase64: string } }).result.contentBase64).toBe(
      'AAAAAAAA'
    )

    const chunk2 = await dispatcher.dispatch(
      makeRequest('trello.readDownloadChunk', {
        downloadId: startData.downloadId,
        offset: 8,
        length: 8
      })
    )
    expect(chunk2.ok).toBe(true)
    expect((chunk2 as { ok: true; result: { contentBase64: string } }).result.contentBase64).toBe(
      'BBBBBBBB'
    )
  })

  it('chunked upload: abort cleans up session', async () => {
    const runtime = makeRuntimeMock()
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    const startResult = await dispatcher.dispatch(
      makeRequest('trello.startUpload', {
        cardId: 'card-1',
        name: 'test.png',
        mimeType: 'image/png',
        expectedBase64Length: 4
      })
    )
    const uploadId = (startResult as { ok: true; result: { uploadId: string } }).result.uploadId

    await dispatcher.dispatch(makeRequest('trello.abortUpload', { uploadId }))

    const commitResult = await dispatcher.dispatch(makeRequest('trello.commitUpload', { uploadId }))
    expect(commitResult.ok).toBe(false)
    expect(runtime.trelloUploadAttachment).not.toHaveBeenCalled()
  })

  it('chunked download: abort cleans up session', async () => {
    const runtime = makeRuntimeMock()
    vi.mocked(runtime.trelloDownloadImage).mockResolvedValue({
      ok: true,
      contentType: 'image/png',
      contentBase64: 'AAAA'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    const startResult = await dispatcher.dispatch(
      makeRequest('trello.startDownload', { url: 'https://trello.com/image.png' })
    )
    const downloadId = (startResult as { ok: true; result: { downloadId: string } }).result
      .downloadId

    await dispatcher.dispatch(makeRequest('trello.abortDownload', { downloadId }))

    const readResult = await dispatcher.dispatch(
      makeRequest('trello.readDownloadChunk', { downloadId, offset: 0, length: 4 })
    )
    expect(readResult.ok).toBe(false)
  })

  it('chunked upload: commit rejects invalid assembled base64', async () => {
    const runtime = makeRuntimeMock()
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    const startResult = await dispatcher.dispatch(
      makeRequest('trello.startUpload', {
        cardId: 'card-1',
        name: 'test.png',
        mimeType: 'image/png',
        expectedBase64Length: 4
      })
    )
    const uploadId = (startResult as { ok: true; result: { uploadId: string } }).result.uploadId

    await dispatcher.dispatch(
      makeRequest('trello.appendUploadChunk', {
        uploadId,
        offset: 0,
        contentBase64: '!!!'
      })
    )

    const commitResult = await dispatcher.dispatch(makeRequest('trello.commitUpload', { uploadId }))
    expect(commitResult.ok).toBe(false)
    expect(runtime.trelloUploadAttachment).not.toHaveBeenCalled()
  })

  it('chunked download: rejects read length exceeding max chunk size', async () => {
    const runtime = makeRuntimeMock()
    vi.mocked(runtime.trelloDownloadImage).mockResolvedValue({
      ok: true,
      contentType: 'image/png',
      contentBase64: 'AAAA'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TRELLO_METHODS })

    const startResult = await dispatcher.dispatch(
      makeRequest('trello.startDownload', { url: 'https://trello.com/image.png' })
    )
    const downloadId = (startResult as { ok: true; result: { downloadId: string } }).result
      .downloadId

    const tooLarge = 512 * 1024 + 1
    const readResult = await dispatcher.dispatch(
      makeRequest('trello.readDownloadChunk', { downloadId, offset: 0, length: tooLarge })
    )
    expect(readResult.ok).toBe(false)
  })
})
