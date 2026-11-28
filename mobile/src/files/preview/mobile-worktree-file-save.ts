import { getWrittenContentDiskSignature } from '../../../../src/shared/file-write/disk-baseline-signature'
import {
  isConfirmedFileNotFoundError,
  parseFileWriteResult,
  type FileWriteDiskConflict
} from '../../../../src/shared/file-write/file-write-disk-precondition'
import { translate } from '../../i18n/mobile-i18n'
import type { RpcFailure } from '../../transport/rpc/rpc-wire-types'
import { fileTextOfPreview } from './mobile-file-preview-editability'
import {
  filePreviewTextRead,
  worktreeFileGuardedWrite,
  type MobileFilePreviewRpcSender
} from './mobile-file-preview-operations'
import type { MobileFilePreviewSource } from './mobile-file-preview-request'
import {
  normalizeMobileFilePreviewResult,
  previewErrorFromRefusal
} from './mobile-file-preview-response'

type WorktreeFileSource = Extract<MobileFilePreviewSource, { source: 'worktree' }>

export type MobileWorktreeFileSaveResult =
  | { status: 'saved' }
  | { status: 'conflict'; conflict: FileWriteDiskConflict }
  | { status: 'error'; message: string }

/**
 * Writes `fileText` only while disk still holds `baseline`, the text this editor loaded or last saved.
 * The host compares at write time, so a desktop change in between is refused, never overwritten.
 */
export async function saveMobileWorktreeFile(
  client: MobileFilePreviewRpcSender,
  source: WorktreeFileSource,
  fileText: string,
  baseline: string,
  options: { allowMissing?: boolean } = {}
): Promise<MobileWorktreeFileSaveResult> {
  const reply = await worktreeFileGuardedWrite.request(client, {
    // Why local: the phone loads only files its host reads over a local route, so a workspace
    // that moved to another host since is refused rather than written.
    expectedExecutionHostId: 'local',
    worktree: `id:${source.worktreeId}`,
    relativePath: source.relativePath,
    content: fileText,
    diskPrecondition: {
      expectedSignature: getWrittenContentDiskSignature(baseline),
      // Why: the phone read the file as UTF-8, so bytes that aren't would be rewritten unasked.
      requireLosslessUtf8: true,
      ...(options.allowMissing ? { allowMissing: true } : {})
    }
  })
  const verdict = worktreeFileGuardedWrite.interpret(reply)
  if (!verdict.accepted) {
    if (reply.ok) {
      throw new Error('Save reply was neither accepted nor refused')
    }
    return { status: 'error', message: saveRefusalMessage(reply.error) }
  }
  const result = parseFileWriteResult(verdict.value)
  if (result.ok) {
    return { status: 'saved' }
  }
  if (result.diskConflict === 'not-utf8') {
    return {
      status: 'error',
      message: translate(
        'files.filePreviewScreen.notUtf8',
        "This file isn't UTF-8 text, so it can't be saved here"
      )
    }
  }
  return { status: 'conflict', conflict: result.diskConflict }
}

/** The text disk holds now, for an Overwrite that must still refuse a change made after this read. */
export async function readMobileWorktreeFileBaseline(
  client: MobileFilePreviewRpcSender,
  source: WorktreeFileSource
): Promise<
  { status: 'ok'; fileText: string } | { status: 'missing' } | { status: 'error'; message: string }
> {
  // Editable files are never images, so their text read is files.read.
  const reply = await filePreviewTextRead.request(client, {
    worktree: `id:${source.worktreeId}`,
    relativePath: source.relativePath
  })
  const verdict = filePreviewTextRead.interpret(reply)
  if (!verdict.accepted) {
    if (reply.ok) {
      throw new Error('Read reply was neither accepted nor refused')
    }
    const refusal = Object.assign(new Error(reply.error.message), { code: reply.error.code })
    return isConfirmedFileNotFoundError(refusal)
      ? { status: 'missing' }
      : { status: 'error', message: refusalMessage(reply.error) }
  }
  const fileText = fileTextOfPreview(
    normalizeMobileFilePreviewResult(source.relativePath, verdict.value)
  )
  return fileText === null
    ? {
        status: 'error',
        message: translate(
          'files.filePreviewScreen.cannotOverwrite',
          "The file on disk can't be edited here anymore"
        )
      }
    : { status: 'ok', fileText }
}

function refusalMessage(error: RpcFailure['error']): string {
  const refused = previewErrorFromRefusal(error)
  return refused.status === 'error' ? refused.message : ''
}

// Why not the read mapper: a write refusal (permission denied, host changed) is not a preview that failed to load.
function saveRefusalMessage(error: RpcFailure['error']): string {
  const mapped = previewErrorFromRefusal(error)
  if (mapped.status === 'error' && mapped.reconnect) {
    return mapped.message
  }
  return error.message || translate('files.filePreviewScreen.saveFailed', 'Unable to save file')
}
