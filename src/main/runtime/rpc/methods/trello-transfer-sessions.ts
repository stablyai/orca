import { randomUUID } from 'node:crypto'
import { isValidBase64, TRELLO_DOWNLOAD_CHUNK_BASE64_CHARS } from './trello-method-schemas'

const TRELLO_UPLOAD_MAX_CONCURRENT = 8
const TRELLO_UPLOAD_TTL_MS = 5 * 60 * 1000
const TRELLO_DOWNLOAD_TTL_MS = 5 * 60 * 1000
const TRELLO_DOWNLOAD_MAX_SESSIONS = 16

type TrelloUploadSession = {
  cardId: string
  name: string
  mimeType: string
  expectedBase64Length: number
  chunks: string[]
  receivedBase64Length: number
  expiresAt: number
  ttlTimer: ReturnType<typeof setTimeout>
}

type TrelloDownloadSession = {
  contentType: string
  contentBase64: string
  expiresAt: number
  ttlTimer: ReturnType<typeof setTimeout>
}

const trelloUploadSessions = new Map<string, TrelloUploadSession>()
const trelloDownloadSessions = new Map<string, TrelloDownloadSession>()

function scheduleUploadSessionExpiry(uploadId: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const session = trelloUploadSessions.get(uploadId)
    if (session && session.expiresAt <= Date.now()) {
      trelloUploadSessions.delete(uploadId)
      clearTimeout(session.ttlTimer)
    }
  }, TRELLO_UPLOAD_TTL_MS)
}

function refreshUploadSessionExpiry(uploadId: string, session: TrelloUploadSession): void {
  clearTimeout(session.ttlTimer)
  session.expiresAt = Date.now() + TRELLO_UPLOAD_TTL_MS
  session.ttlTimer = scheduleUploadSessionExpiry(uploadId)
}

export function pruneExpiredUploadSessions(now = Date.now()): void {
  for (const [uploadId, session] of trelloUploadSessions) {
    if (session.expiresAt <= now) {
      clearTimeout(session.ttlTimer)
      trelloUploadSessions.delete(uploadId)
    }
  }
}

function getUploadSession(uploadId: string): TrelloUploadSession {
  const session = trelloUploadSessions.get(uploadId)
  if (!session) {
    throw new Error('Trello upload session not found or expired')
  }
  if (session.expiresAt <= Date.now()) {
    trelloUploadSessions.delete(uploadId)
    clearTimeout(session.ttlTimer)
    throw new Error('Trello upload session expired')
  }
  return session
}

export function startTrelloUploadSession(args: {
  cardId: string
  name: string
  mimeType: string
  expectedBase64Length: number
}): { uploadId: string } {
  pruneExpiredUploadSessions()
  if (trelloUploadSessions.size >= TRELLO_UPLOAD_MAX_CONCURRENT) {
    throw new Error('Too many Trello uploads are in progress')
  }
  const uploadId = randomUUID()
  trelloUploadSessions.set(uploadId, {
    ...args,
    chunks: [],
    receivedBase64Length: 0,
    expiresAt: Date.now() + TRELLO_UPLOAD_TTL_MS,
    ttlTimer: scheduleUploadSessionExpiry(uploadId)
  })
  return { uploadId }
}

export function appendTrelloUploadSessionChunk(args: {
  uploadId: string
  offset: number
  contentBase64: string
}): { receivedBase64Length: number } {
  const session = getUploadSession(args.uploadId)
  if (args.offset !== session.receivedBase64Length) {
    throw new Error('Trello upload chunk offset is out of order')
  }
  const nextLength = session.receivedBase64Length + args.contentBase64.length
  if (nextLength > session.expectedBase64Length) {
    throw new Error('Trello upload exceeded expected size')
  }
  session.chunks.push(args.contentBase64)
  session.receivedBase64Length = nextLength
  refreshUploadSessionExpiry(args.uploadId, session)
  return { receivedBase64Length: session.receivedBase64Length }
}

export function getCommittedTrelloUpload(uploadId: string): {
  cardId: string
  name: string
  mimeType: string
  contentBase64: string
} {
  const session = getUploadSession(uploadId)
  if (session.receivedBase64Length !== session.expectedBase64Length) {
    throw new Error('Trello upload is incomplete')
  }
  const contentBase64 = session.chunks.join('')
  if (!isValidBase64(contentBase64)) {
    throw new Error('Assembled upload content is not valid base64')
  }
  return {
    cardId: session.cardId.trim(),
    name: session.name.trim(),
    mimeType: session.mimeType.trim(),
    contentBase64
  }
}

export function deleteTrelloUploadSession(uploadId: string): void {
  const session = trelloUploadSessions.get(uploadId)
  if (session) {
    clearTimeout(session.ttlTimer)
    trelloUploadSessions.delete(uploadId)
  }
}

function scheduleDownloadSessionExpiry(downloadId: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const session = trelloDownloadSessions.get(downloadId)
    if (session && session.expiresAt <= Date.now()) {
      trelloDownloadSessions.delete(downloadId)
      clearTimeout(session.ttlTimer)
    }
  }, TRELLO_DOWNLOAD_TTL_MS)
}

export function pruneExpiredDownloadSessions(now = Date.now()): void {
  for (const [downloadId, session] of trelloDownloadSessions) {
    if (session.expiresAt <= now) {
      clearTimeout(session.ttlTimer)
      trelloDownloadSessions.delete(downloadId)
    }
  }
}

function refreshDownloadSessionExpiry(downloadId: string, session: TrelloDownloadSession): void {
  clearTimeout(session.ttlTimer)
  session.expiresAt = Date.now() + TRELLO_DOWNLOAD_TTL_MS
  session.ttlTimer = scheduleDownloadSessionExpiry(downloadId)
}

function getDownloadSession(downloadId: string): TrelloDownloadSession {
  const session = trelloDownloadSessions.get(downloadId)
  if (!session) {
    throw new Error('Trello download session not found or expired')
  }
  if (session.expiresAt <= Date.now()) {
    trelloDownloadSessions.delete(downloadId)
    clearTimeout(session.ttlTimer)
    throw new Error('Trello download session expired')
  }
  return session
}

export function startTrelloDownloadSession(args: { contentType: string; contentBase64: string }): {
  downloadId: string
  contentType: string
  totalBase64Length: number
  chunkSize: number
} {
  pruneExpiredDownloadSessions()
  if (trelloDownloadSessions.size >= TRELLO_DOWNLOAD_MAX_SESSIONS) {
    throw new Error('Too many Trello downloads are in progress')
  }
  const downloadId = randomUUID()
  trelloDownloadSessions.set(downloadId, {
    ...args,
    expiresAt: Date.now() + TRELLO_DOWNLOAD_TTL_MS,
    ttlTimer: scheduleDownloadSessionExpiry(downloadId)
  })
  return {
    downloadId,
    contentType: args.contentType,
    totalBase64Length: args.contentBase64.length,
    chunkSize: TRELLO_DOWNLOAD_CHUNK_BASE64_CHARS
  }
}

export function readTrelloDownloadSessionChunk(args: {
  downloadId: string
  offset: number
  length: number
}): { contentBase64: string } {
  if (args.length > TRELLO_DOWNLOAD_CHUNK_BASE64_CHARS) {
    throw new Error('Trello download chunk exceeds maximum allowed size')
  }
  const session = getDownloadSession(args.downloadId)
  const end = Math.min(args.offset + args.length, session.contentBase64.length)
  refreshDownloadSessionExpiry(args.downloadId, session)
  return { contentBase64: session.contentBase64.slice(args.offset, end) }
}

export function deleteTrelloDownloadSession(downloadId: string): void {
  const session = trelloDownloadSessions.get(downloadId)
  if (session) {
    clearTimeout(session.ttlTimer)
    trelloDownloadSessions.delete(downloadId)
  }
}

export function resetTrelloTransferSessionsForTest(): void {
  for (const [id, session] of trelloUploadSessions) {
    clearTimeout(session.ttlTimer)
    trelloUploadSessions.delete(id)
  }
  for (const [id, session] of trelloDownloadSessions) {
    clearTimeout(session.ttlTimer)
    trelloDownloadSessions.delete(id)
  }
}
