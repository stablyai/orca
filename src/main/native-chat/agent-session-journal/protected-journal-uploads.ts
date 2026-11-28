import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeAgentSessionAttachmentName } from '../../../shared/agent-session/agent-session-attachments'
import {
  agentSessionAttachmentStoreRoot,
  isAgentSessionAttachmentUploadId
} from '../agent-session-attachments/agent-session-attachment-references'

export type ProtectedUpload = {
  workspaceId: string
  sessionId: string
  sourcePath: string
  expectedHash: string
  uploadId: string
  name: string
  bytes: Uint8Array
}
export async function retainProtectedUpload(
  state: string,
  workspaceId: string,
  upload: ProtectedUpload
) {
  if (
    upload.workspaceId !== workspaceId ||
    !isAgentSessionAttachmentUploadId(upload.uploadId) ||
    !/^[\w-]{1,128}$/.test(upload.sessionId) ||
    !upload.name ||
    upload.name !== sanitizeAgentSessionAttachmentName(upload.name) ||
    upload.name === '.upload.part' ||
    !(upload.bytes instanceof Uint8Array) ||
    upload.bytes.length > 16 * 1024 * 1024
  ) {
    throw new Error('invalid protected upload')
  }
  const dir = join(agentSessionAttachmentStoreRoot(state), upload.uploadId)
  const refs = join(state, 'protected-upload-receipts')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await mkdir(refs, { recursive: true, mode: 0o700 })
  const digest = createHash('sha256').update(upload.bytes).digest('hex')
  if (
    digest !== upload.expectedHash ||
    !upload.sourcePath.endsWith(`/${upload.uploadId}/${upload.name}`)
  ) {
    throw new Error('upload origin or bytes changed')
  }
  const receipt = Buffer.from(
    JSON.stringify({
      sessionId: upload.sessionId,
      name: upload.name,
      sha256: digest,
      sourcePath: upload.sourcePath
    })
  )
  for (const [path, bytes] of [
    [join(refs, upload.uploadId), receipt],
    [join(dir, upload.name), upload.bytes]
  ] as const) {
    const tmp = join(dir, `.${randomUUID()}.part`)
    const f = await open(tmp, 'wx', 0o600)
    try {
      await f.writeFile(bytes)
      await f.sync()
      try {
        await link(tmp, path)
      } catch (e) {
        if (
          !(e instanceof Error && 'code' in e && e.code === 'EEXIST') ||
          !(await readFile(path)).equals(bytes)
        ) {
          throw new Error('protected upload conflict')
        }
      }
    } finally {
      await f.close()
      await rm(tmp, { force: true })
    }
  }
  for (const parent of [dir, refs, agentSessionAttachmentStoreRoot(state)]) {
    const handle = await open(parent, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  return { uploadId: upload.uploadId, sha256: digest }
}
