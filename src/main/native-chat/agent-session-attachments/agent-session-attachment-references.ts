import { isAbsolute, join, relative, sep } from 'node:path'
import {
  AGENT_SESSION_ATTACHMENTS_DIR_NAME,
  sanitizeAgentSessionAttachmentName
} from '../../../shared/agent-session/agent-session-attachments'
import type { AgentSessionExpiredAttachment } from '../../../shared/agent-session/failures/agent-session-expired-attachments'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

export const AGENT_SESSION_ATTACHMENT_PART_FILE = '.upload.part'

const UPLOAD_ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UPLOAD_ID = new RegExp(`^${UPLOAD_ID_SOURCE}$`)

export function agentSessionAttachmentStoreRoot(stateDirectory: string): string {
  return join(stateDirectory, AGENT_SESSION_ATTACHMENTS_DIR_NAME)
}

export function isAgentSessionAttachmentUploadId(value: string): boolean {
  return UPLOAD_ID.test(value)
}

/** Accept only committed files directly inside this store's upload directories. */
export function parseAgentSessionAttachmentStorePath(
  root: string,
  filePath: string
): { uploadId: string; name: string } | null {
  if (!isAbsolute(filePath)) {
    return null
  }
  const inside = relative(root, filePath)
  const segments = inside.split(sep)
  const [uploadId, name] = segments
  if (
    inside === '' ||
    isAbsolute(inside) ||
    segments.length !== 2 ||
    !uploadId ||
    !name ||
    !isAgentSessionAttachmentUploadId(uploadId) ||
    name === AGENT_SESSION_ATTACHMENT_PART_FILE
  ) {
    return null
  }
  return { uploadId, name }
}

// Reject store-root matches embedded inside longer paths.
const PATH_CHARACTER = /[\w.~\\/-]/

function normalizedRoot(root: string, platform: NodeJS.Platform): string {
  const forward = root.replace(/\\/g, '/')
  return platform === 'win32' ? forward.toLowerCase() : forward
}

type AttachmentReference = {
  uploadId: string
  block: AgentJournalMessageItem['blocks'][number]
  text: string
  rootStart: number
  idEnd: number
}

/** Match exact decoded store roots; quoting/spaces cannot hide references and Windows accepts either separator. */
function* attachmentReferences(
  root: string,
  body: AgentJournalMessageItem,
  platform: NodeJS.Platform
): Generator<AttachmentReference> {
  const ownRoot = normalizedRoot(root, platform)
  const pattern = new RegExp(
    `${AGENT_SESSION_ATTACHMENTS_DIR_NAME}[\\\\/](${UPLOAD_ID_SOURCE})(?![0-9a-z-])`,
    platform === 'win32' ? 'gi' : 'g'
  )
  for (const block of body.blocks) {
    const text =
      block.type === 'text' ? block.text : block.type === 'image-ref' ? block.path : undefined
    if (!text) {
      continue
    }
    for (const match of text.matchAll(pattern)) {
      const rootEnd = match.index + AGENT_SESSION_ATTACHMENTS_DIR_NAME.length
      const rootStart = rootEnd - root.length
      const uploadId = match[1]?.toLowerCase()
      if (
        uploadId &&
        rootStart >= 0 &&
        !PATH_CHARACTER.test(text.charAt(rootStart - 1)) &&
        normalizedRoot(text.slice(rootStart, rootEnd), platform) === ownRoot
      ) {
        yield { uploadId, block, text, rootStart, idEnd: match.index + match[0].length }
      }
    }
  }
}

export function agentSessionAttachmentReferences(
  root: string,
  body: AgentJournalMessageItem,
  platform: NodeJS.Platform = process.platform
): Set<string> {
  const uploadIds = new Set<string>()
  for (const { uploadId } of attachmentReferences(root, body, platform)) {
    uploadIds.add(uploadId)
  }
  return uploadIds
}

/** An image block is the whole path; a text reference ends at its quote, or at whitespace because only paths without any go unquoted. */
function referencedFileName({ block, text, rootStart, idEnd }: AttachmentReference): string | null {
  if (!/[\\/]/.test(text.charAt(idEnd))) {
    return null
  }
  const rest = text.slice(idEnd + 1)
  const opening = text.charAt(rootStart - 1)
  const end =
    block.type === 'image-ref'
      ? -1
      : opening === '"' || opening === "'"
        ? rest.indexOf(opening)
        : rest.search(/\s/)
  const name = (end === -1 ? rest : rest.slice(0, end)).split(/[\\/]/)[0]
  return name ? sanitizeAgentSessionAttachmentName(name) : null
}

/** Each listed upload with the file name the message gave it, or its id when it gave none, since an expired upload has nothing left on disk to read one from. */
export function agentSessionAttachmentReferenceNames(
  root: string,
  body: AgentJournalMessageItem,
  uploadIds: readonly string[],
  platform: NodeJS.Platform = process.platform
): AgentSessionExpiredAttachment[] {
  const names = new Map<string, string>()
  for (const reference of attachmentReferences(root, body, platform)) {
    if (!names.has(reference.uploadId)) {
      const name = referencedFileName(reference)
      if (name) {
        names.set(reference.uploadId, name)
      }
    }
  }
  return uploadIds.map((uploadId) => ({ uploadId, name: names.get(uploadId) ?? uploadId }))
}
