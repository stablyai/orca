import { createHash } from 'node:crypto'
import { stat, realpath } from 'node:fs/promises'
import { openAuthorizedDocPreviewTarget } from '../../../shared/doc-preview-file-access'
import { validateFileRangeRequest } from '../../../shared/file-range-read'
import { remoteRpcResultExceedsContentBudget } from '../../../shared/remote-rpc-content-budget'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../../shared/agent-session-attachments'
import type {
  AttachmentTextChunk,
  AttachmentTextRequest
} from '../../../shared/attachment-text-source'
import { parseAgentSessionAttachmentStorePath } from './agent-session-attachment-references'

export async function readAttachmentTextChunk(
  root: string,
  request: AttachmentTextRequest,
  maxContentBytes?: number
): Promise<AttachmentTextChunk> {
  validateFileRangeRequest(request.offset, request.length)
  if (
    request.path.split(/[\\/]/).includes('..') ||
    !parseAgentSessionAttachmentStorePath(root, request.path)
  ) {
    throw new Error('Not a committed chat attachment')
  }
  const { handle, canonicalTarget } = await openAuthorizedDocPreviewTarget({
    boundaryPath: root,
    entryPath: request.path,
    targetPath: request.path,
    implicitRootPath: null,
    authorizedRootPaths: []
  })
  try {
    const snapshot = async () => {
      const [opened, current, canonical] = await Promise.all([
        handle.stat({ bigint: true }),
        stat(canonicalTarget, { bigint: true }),
        realpath(request.path)
      ])
      if (
        canonical !== canonicalTarget ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino ||
        opened.size !== current.size ||
        opened.mtimeNs !== current.mtimeNs ||
        opened.ctimeNs !== current.ctimeNs ||
        opened.size > BigInt(AGENT_SESSION_ATTACHMENT_MAX_BYTES)
      ) {
        throw new Error('Attachment changed. Close it and try again.')
      }
      return {
        size: Number(opened.size),
        snapshot: createHash('sha256')
          .update(
            [
              canonicalTarget,
              opened.dev,
              opened.ino,
              opened.size,
              opened.mtimeNs,
              opened.ctimeNs
            ].join(':')
          )
          .digest('hex')
      }
    }
    const before = await snapshot()
    if (request.expectedSnapshot && before.snapshot !== request.expectedSnapshot) {
      throw new Error('Attachment changed. Close it and try again.')
    }
    if (request.offset > before.size) {
      throw new Error('Attachment offset is beyond its end')
    }
    const buffer = Buffer.alloc(Math.min(request.length, before.size - request.offset))
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const next = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        request.offset + bytesRead
      )
      if (!next.bytesRead) {
        break
      }
      bytesRead += next.bytesRead
    }
    const after = await snapshot()
    if (before.snapshot !== after.snapshot || (!bytesRead && request.offset < before.size)) {
      throw new Error('Attachment changed. Close it and try again.')
    }
    const reply = {
      ...before,
      contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
      bytesRead,
      eof: request.offset + bytesRead === before.size
    }
    if (
      maxContentBytes !== undefined &&
      remoteRpcResultExceedsContentBudget(reply, maxContentBytes)
    ) {
      throw new Error('Attachment reply is too large. Try again with a smaller chunk.')
    }
    return reply
  } finally {
    await handle.close()
  }
}
