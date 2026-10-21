// How the host recognizes its own attachment store in what a client sends: a stored file is
// `<store root>/<upload id>/<name>`, and only the upload id is needed to know which upload it is.

import { isAbsolute, join, relative, sep } from 'node:path'
import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from '../../../shared/agent-session-attachments'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'

export const AGENT_SESSION_ATTACHMENT_PART_FILE = '.upload.part'

const UPLOAD_ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UPLOAD_ID = new RegExp(`^${UPLOAD_ID_SOURCE}$`)

export function agentSessionAttachmentStoreRoot(stateDirectory: string): string {
  return join(stateDirectory, AGENT_SESSION_ATTACHMENTS_DIR_NAME)
}

export function isAgentSessionAttachmentUploadId(value: string): boolean {
  return UPLOAD_ID.test(value)
}

/** The upload a stored file belongs to, or null for anything that is not exactly a committed file
 *  directly in an upload directory of this store. */
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

// A root preceded by one of these is the tail of some other, longer path.
const PATH_CHARACTER = /[\w.~\\/-]/

function normalizedRoot(root: string, platform: NodeJS.Platform): string {
  const forward = root.replace(/\\/g, '/')
  return platform === 'win32' ? forward.toLowerCase() : forward
}

/**
 * The uploads of this host's store a message body names, in image paths and file references in its
 * text alike. Only a path that starts with this host's exact store root counts: matched on the
 * decoded body by `<store root>/<upload id>`, so quoting or a file name with spaces cannot hide one,
 * and Windows paths match with either separator and in any case. Any other mention of a store
 * path (another server's, a `~` form, a bare name) is only text.
 */
export function agentSessionAttachmentReferences(
  root: string,
  body: AgentJournalMessageItem,
  platform: NodeJS.Platform = process.platform
): Set<string> {
  const uploadIds = new Set<string>()
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
        uploadIds.add(uploadId)
      }
    }
  }
  return uploadIds
}
