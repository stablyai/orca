import { open, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isConnectorFileId } from '../../shared/connector-asker-file-validation'
import { parseAgentSessionAttachmentStorePath } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'

// Keep connector metadata with the upload so older Orca versions can read the same chat journal.
const CONNECTOR_FILE_ID = '.connector-file-id'

export async function storeConnectorImage(
  store: AgentSessionAttachmentStore,
  name: string,
  bytes: Buffer,
  fileId: string | undefined
): Promise<string> {
  const path = await store.storeFile(name, bytes)
  if (fileId !== undefined) {
    await writeFile(join(dirname(path), CONNECTOR_FILE_ID), fileId, { flag: 'wx' })
  }
  return path
}

export async function storedConnectorImageId(
  root: string | undefined,
  path: string
): Promise<string | undefined> {
  if (!root || !parseAgentSessionAttachmentStorePath(root, path)) {
    return undefined
  }
  const file = await open(join(dirname(path), CONNECTOR_FILE_ID), 'r').catch(() => null)
  if (!file) {
    return undefined
  }
  try {
    // One byte more than the largest valid ID, so a longer value cannot match by prefix.
    const bytes = Buffer.alloc(65)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const fileId = bytes.toString('utf8', 0, bytesRead)
    return isConnectorFileId(fileId) ? fileId : undefined
  } catch {
    return undefined
  } finally {
    await file.close().catch(() => {})
  }
}
