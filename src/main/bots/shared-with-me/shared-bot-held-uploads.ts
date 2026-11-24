// Attachments for a message that will be held for a shared agent's away host: kept on this device,
// since the host that would store them can't be reached, and sealed into the held message itself.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../../../shared/agent-session/agent-session-attachments'
import { SHARED_BOT_HOST_ERRORS } from '../../../shared/bots/shared-bot-hosts'
import { MAX_HELD_MESSAGE_CHARS } from '../../../shared/connector-share-contract'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  AttachmentUploadAppendParams,
  AttachmentUploadIdParams,
  AttachmentUploadStartParams
} from '../../../shared/rpc-contract/structured-agent-session/agent-session-attachment-params'

// Append, commit and abort all name their upload.
const UploadOf = z.looseObject({ uploadId: z.string() })

export const SHARED_BOT_UPLOAD_METHODS: ReadonlySet<string> = new Set([
  'agentSessionAttachment.uploadStart',
  'agentSessionAttachment.uploadAppend',
  'agentSessionAttachment.uploadCommit',
  'agentSessionAttachment.uploadAbort'
])

// Where a kept attachment is named in the message's body until it is sealed.
const PATH_PREFIX = 'shared-held-attachment:'
// Sealed as base64, a file past this can't fit one held message.
const MAX_HELD_ATTACHMENT_BYTES = Math.floor((MAX_HELD_MESSAGE_CHARS * 3) / 4)

type Upload = { name: string; byteLength: number; chunks: Buffer[]; received: number }

export type SharedBotHeldAttachment = { name: string; contentBase64: string }

export class SharedBotHeldUploads {
  private readonly open = new Map<string, Upload>()
  // By path, oldest first; at most one message's worth, as a message can hold no more.
  private readonly kept = new Map<string, SharedBotHeldAttachment>()

  /** Whether an upload call continues one kept here. */
  owns(params: unknown): boolean {
    const uploadId = UploadOf.safeParse(params).data?.uploadId
    return uploadId !== undefined && this.open.has(uploadId)
  }

  isKept(path: string): boolean {
    return this.kept.has(path)
  }

  /** The kept attachment at `path`, or null when it isn't one (or is gone). */
  read(path: string): SharedBotHeldAttachment | null {
    return this.kept.get(path) ?? null
  }

  /** Forgets attachments once their message is held. */
  release(paths: readonly string[]): void {
    for (const path of paths) {
      this.kept.delete(path)
    }
  }

  /** An `agentSessionAttachment.upload*` call, answered here as the host's store would. */
  call(method: string, params: unknown, ownerName: string): RuntimeRpcResponse<unknown> {
    try {
      return {
        id: method,
        ok: true,
        result: this.answer(method, params, ownerName),
        _meta: { runtimeId: '' }
      }
    } catch (error) {
      return {
        id: method,
        ok: false,
        error: {
          code:
            error instanceof TooLargeToHold ? SHARED_BOT_HOST_ERRORS.tooLarge : 'invalid_argument',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }

  private answer(method: string, params: unknown, ownerName: string): unknown {
    switch (method) {
      case 'agentSessionAttachment.uploadStart': {
        const start = AttachmentUploadStartParams.parse(params)
        if (start.byteLength > MAX_HELD_ATTACHMENT_BYTES) {
          throw new TooLargeToHold(
            `Too large to hold; send it when ${ownerName}’s computer is online`
          )
        }
        const uploadId = randomUUID()
        this.open.set(uploadId, { ...start, chunks: [], received: 0 })
        for (const old of [...this.open.keys()].slice(0, -AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT)) {
          this.open.delete(old)
        }
        return { uploadId }
      }
      case 'agentSessionAttachment.uploadAppend': {
        const append = AttachmentUploadAppendParams.parse(params)
        const upload = this.upload(append.uploadId)
        const chunk = Buffer.from(append.contentBase64, 'base64')
        if (
          append.offset !== upload.received ||
          upload.received + chunk.length > upload.byteLength
        ) {
          throw new Error('Attachment chunk is out of order')
        }
        upload.chunks.push(chunk)
        upload.received += chunk.length
        return {}
      }
      case 'agentSessionAttachment.uploadCommit': {
        const { uploadId } = AttachmentUploadIdParams.parse(params)
        const upload = this.upload(uploadId)
        this.open.delete(uploadId)
        if (upload.received !== upload.byteLength) {
          throw new Error('Attachment is incomplete')
        }
        const path = `${PATH_PREFIX}${uploadId}`
        this.kept.set(path, {
          name: upload.name,
          contentBase64: Buffer.concat(upload.chunks).toString('base64')
        })
        for (const old of [...this.kept.keys()].slice(0, -AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT)) {
          this.kept.delete(old)
        }
        return { path, name: upload.name, byteLength: upload.byteLength }
      }
      default: {
        this.open.delete(AttachmentUploadIdParams.parse(params).uploadId)
        return {}
      }
    }
  }

  private upload(uploadId: string): Upload {
    const upload = this.open.get(uploadId)
    if (!upload) {
      throw new Error('Unknown upload')
    }
    return upload
  }
}

class TooLargeToHold extends Error {}
