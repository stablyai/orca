import * as z from 'zod'
import type { PickedMobileFile } from '../../platform/media-picker-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import {
  interpretUploadReply,
  MobileFileUploadRefusedError,
  uploadFileInChunks
} from './mobile-chunked-file-upload'

const uploadSlotSchema = z.looseObject({ uploadId: z.string() })
const storedFileSchema = z.looseObject({
  path: z.string(),
  name: z.string(),
  byteLength: z.number()
})

const terminalFileUploadStart = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal-file-upload.start',
    method: 'terminalFileUpload.start',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-file-upload-slot', uploadSlotSchema)
  })
)

const terminalFileUploadAppend = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal-file-upload.append',
    method: 'terminalFileUpload.append',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-file-upload-chunk-appended', z.unknown())
  })
)

const terminalFileUploadCommit = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal-file-upload.commit',
    method: 'terminalFileUpload.commit',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-file-upload-stored', storedFileSchema)
  })
)

/** Its own outcome is discarded: the failure that brought the caller here is the one to report. */
const terminalFileUploadAbort = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal-file-upload.abort-or-skip',
    method: 'terminalFileUpload.abort',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-file-upload-aborted', z.unknown())
  })
)

type MobileTerminalFileRpcSender = Parameters<typeof terminalFileUploadStart.request>[0]

export type MobileTerminalStoredFile = { path: string; name: string; byteLength: number }

/** Stores the file on the host that runs the terminal; the host refuses out-of-order appends, so none is retried. */
export function uploadMobileTerminalFile(
  client: MobileTerminalFileRpcSender,
  args: {
    file: PickedMobileFile
    connectionId: string | null
    signal?: AbortSignal
    onProgress?: (sentBytes: number) => void
  }
): Promise<MobileTerminalStoredFile> {
  return uploadFileInChunks({
    file: args.file,
    signal: args.signal,
    onProgress: args.onProgress,
    start: async () => {
      const reply = await terminalFileUploadStart.request(client, {
        name: args.file.name,
        byteLength: args.file.byteLength,
        connectionId: args.connectionId
      })
      try {
        return interpretUploadReply(() => terminalFileUploadStart.interpret(reply)).uploadId
      } catch (error) {
        // The host takes files only for its own worktrees; an SSH worktree's start is refused.
        throw error instanceof MobileFileUploadRefusedError && args.connectionId !== null
          ? new MobileFileUploadRefusedError(error.hostMessage, 'ssh-workspace')
          : error
      }
    },
    append: async (uploadId, offset, contentBase64) => {
      const reply = await terminalFileUploadAppend.request(client, {
        uploadId,
        offset,
        contentBase64
      })
      interpretUploadReply(() => terminalFileUploadAppend.interpret(reply))
    },
    commit: async (uploadId) => {
      const reply = await terminalFileUploadCommit.request(client, { uploadId })
      return interpretUploadReply(() => terminalFileUploadCommit.interpret(reply))
    },
    abort: async (uploadId) => {
      await terminalFileUploadAbort.request(client, { uploadId })
    }
  })
}
