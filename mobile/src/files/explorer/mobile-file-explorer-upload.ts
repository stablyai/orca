import * as z from 'zod'
import { base64DecodedByteLength } from '../../../../src/shared/agent-session/agent-session-attachments'
import {
  STAGED_FILE_SAVE_CHUNK_BYTES,
  STAGED_FILE_UPLOAD_METHODS
} from '../../../../src/shared/file-write/staged-file-save'
import { BRIDGE_MEDIA_READ_MAX_BYTES } from '../../mobile-web-shell/bridge/native-capabilities/bridge-media-verbs'
import type { StagedMobileFile } from '../../platform/media-picking/media-picker-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { captureMobileFileMutationOwnership } from '../mutation-ownership/mobile-file-mutation-ownership'
import { isFileExistsErrorMessage } from '../mutation-ownership/file-exists-error'
import {
  explorerWorktreeSelector,
  freeCopyPaths,
  noFreeCopyNameMessage,
  type ExplorerTarget
} from './mobile-file-explorer-mutations'

const BEGIN_TIMEOUT_MS = 15_000
const CHUNK_TIMEOUT_MS = 30_000
// The host copies the whole file into the folder before it answers.
const COMMIT_TIMEOUT_MS = 60_000
// One shell read is one host chunk, so its base64 goes on unchanged.
const UPLOAD_CHUNK_BYTES = Math.min(BRIDGE_MEDIA_READ_MAX_BYTES, STAGED_FILE_SAVE_CHUNK_BYTES)

const uploadBegin = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-upload-begin',
    method: STAGED_FILE_UPLOAD_METHODS.begin,
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('explorer-upload-begun', z.looseObject({ saveId: z.string() }))
  })
)

const uploadChunk = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-upload-chunk',
    method: STAGED_FILE_UPLOAD_METHODS.chunk,
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('explorer-upload-chunk-staged', z.unknown())
  })
)

const uploadCommit = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-upload-commit',
    method: STAGED_FILE_UPLOAD_METHODS.commit,
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('explorer-upload-committed', z.unknown())
  })
)

/** Its own outcome is discarded: the failure that brought the caller here is the one to report. */
const uploadAbort = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.explorer-upload-abort-or-skip',
    method: STAGED_FILE_UPLOAD_METHODS.abort,
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('explorer-upload-aborted', z.unknown())
  })
)

export type UploadEvents = {
  progress: (sentBytes: number) => void
}

/** The commit went out and no answer came back: the host may have finished the file, so nothing retries it blind. */
export class UploadUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super("Couldn't confirm the upload. Check the folder.", { cause })
    this.name = 'UploadUnconfirmedError'
  }
}

/**
 * Streams one picked file into `relativePath`, a shell read at a time. The host keeps the bytes outside
 * the workspace until the commit, which never replaces a file: a taken name rejects with "already exists".
 */
export async function uploadStagedFile(
  client: RpcClient,
  target: ExplorerTarget,
  file: StagedMobileFile,
  relativePath: string,
  events: UploadEvents
): Promise<void> {
  const worktree = explorerWorktreeSelector(target)
  const { saveId } = uploadBegin.interpret(
    await uploadBegin.request(
      client,
      {
        worktree,
        relativePath,
        totalBytes: file.byteLength,
        ...(await captureMobileFileMutationOwnership(client, worktree))
      },
      { timeoutMs: BEGIN_TIMEOUT_MS }
    )
  )
  try {
    let offset = 0
    for (;;) {
      // An empty file still needs one read to learn it ended; the shell refuses zero-length reads.
      const length = Math.max(1, Math.min(UPLOAD_CHUNK_BYTES, file.byteLength - offset))
      const chunk = await file.read(offset, length)
      const bytes = base64DecodedByteLength(chunk.base64)
      if (bytes > 0) {
        uploadChunk.interpret(
          await uploadChunk.request(
            client,
            { saveId, offset, contentBase64: chunk.base64 },
            { timeoutMs: CHUNK_TIMEOUT_MS }
          )
        )
        offset += bytes
        events.progress(offset)
      }
      if (chunk.eof) {
        break
      }
      if (bytes === 0) {
        throw new Error('The phone stopped reading the file before it ended')
      }
    }
    if (offset !== file.byteLength) {
      throw new Error('The file changed on the phone while it was uploading')
    }
    // A reply, even a refusal, is the host's answer; no reply leaves the file's fate open.
    const committed = await uploadCommit
      .request(client, { saveId }, { timeoutMs: COMMIT_TIMEOUT_MS })
      .catch((error: unknown) => {
        throw new UploadUnconfirmedError(error)
      })
    uploadCommit.interpret(committed)
  } catch (error) {
    // Best effort: the host drops an idle or disconnected upload by itself.
    void uploadAbort.request(client, { saveId }).catch(() => {})
    throw error
  }
}

/** Uploads under the first free copy name ("a copy.pdf"), and the next one if someone takes it meanwhile. */
export async function uploadStagedFileAsCopy(
  client: RpcClient,
  target: ExplorerTarget,
  file: StagedMobileFile,
  parent: string,
  events: UploadEvents
): Promise<string> {
  for await (const relativePath of freeCopyPaths(client, target, parent, file.name)) {
    try {
      await uploadStagedFile(client, target, file, relativePath, events)
      return relativePath
    } catch (error) {
      if (error instanceof Error && isFileExistsErrorMessage(error.message)) {
        continue
      }
      throw error
    }
  }
  throw new Error(noFreeCopyNameMessage(file.name))
}

/** The name Keep Both would use now; undefined when the host can't say. */
export async function firstFreeCopyName(
  client: RpcClient,
  target: ExplorerTarget,
  parent: string,
  name: string
): Promise<string | undefined> {
  try {
    for await (const relativePath of freeCopyPaths(client, target, parent, name)) {
      return relativePath.slice(parent ? parent.length + 1 : 0)
    }
  } catch {
    // The sheet then offers Keep Both without naming the copy.
  }
  return undefined
}
