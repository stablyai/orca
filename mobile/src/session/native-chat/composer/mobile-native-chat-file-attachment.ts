import { formatNativeChatFileReference } from '../../../../../src/shared/agent-image-paste'
import {
  MobileFileTooLargeError,
  type PickedMobileFile
} from '../../../platform/media-picker-contract'
import type { AgentSessionAttachmentUploadCommitResult } from '../../../../../src/shared/agent-session-attachments'

/** A file in the composer: its chip shows from the pick, and `path` arrives once the host stored it. */
export type PendingNativeChatFile = {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly byteLength: number
  /** The host's stored path; null while the upload runs. */
  readonly path: string | null
}

/** The message text with each stored file referenced after it, the way desktop sends a file. */
export function nativeChatTextWithFileReferences(
  text: string,
  files: readonly { readonly path: string }[]
): string {
  if (files.length === 0) {
    return text
  }
  const joined = files.map((file) => formatNativeChatFileReference(file.path)).join(' ')
  return text.trim().length === 0 ? joined : `${text.trimEnd()}\n${joined}`
}

/** One line a person reads when an attach goes wrong. */
function nativeChatFileAttachFailureMessage(error: unknown, fileName?: string): string {
  if (error instanceof MobileFileTooLargeError) {
    return error.message
  }
  return fileName ? `Couldn't upload ${fileName}` : "Couldn't attach that file"
}

/**
 * Uploads each picked file in turn: a chip per file as soon as it is picked, its path once stored,
 * and the chip gone again when its upload fails. A picker failure ends the pick; uploads already
 * stored stay.
 */
export async function uploadPickedNativeChatFiles(args: {
  picked: AsyncIterable<PickedMobileFile>
  upload: (file: PickedMobileFile) => Promise<AgentSessionAttachmentUploadCommitResult>
  nextId: () => string
  onPicked: (file: PendingNativeChatFile) => void
  onStored: (id: string, stored: AgentSessionAttachmentUploadCommitResult) => void
  onFailed: (id: string) => void
  onError: (message: string) => void
}): Promise<void> {
  try {
    for await (const file of args.picked) {
      const id = args.nextId()
      args.onPicked({
        id,
        name: file.name,
        mime: file.mime,
        byteLength: file.byteLength,
        path: null
      })
      try {
        args.onStored(id, await args.upload(file))
      } catch (error) {
        args.onFailed(id)
        args.onError(nativeChatFileAttachFailureMessage(error, file.name))
      }
    }
  } catch (error) {
    args.onError(nativeChatFileAttachFailureMessage(error))
  }
}
