import { formatNativeChatFileReference } from '../../../../../src/shared/agent-image-paste'
import { chatTextAttachmentName } from '../../../../../src/shared/native-chat-text-attachment-references'
import {
  MobileFileTooLargeError,
  type PickedMobileFile
} from '../../../platform/media-picker-contract'
import { MobileFileUploadRefusedError } from '../../../files/attachments/mobile-chunked-file-upload'

export type PendingNativeChatFile = {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly byteLength: number
  readonly path: string | null
  /** Bytes the host has acknowledged so far; drives the transfer progress on the chip. */
  readonly sentBytes: number
}

type StoredNativeChatFile = { readonly name: string; readonly path: string }

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

function nativeChatFileAttachFailureMessage(error: unknown, fileName?: string): string {
  if (error instanceof MobileFileTooLargeError) {
    return error.message
  }
  if (!fileName) {
    return "Couldn't attach that file"
  }
  const name = chatTextAttachmentName(fileName)
  // The host answered: the connection held, so backgrounding was not the cause.
  if (error instanceof MobileFileUploadRefusedError) {
    if (error.reason === 'ssh-workspace') {
      return "Files can't be sent to SSH workspaces yet"
    }
    return error.hostMessage
      ? `Couldn't send ${name}: ${error.hostMessage}`
      : `Couldn't send ${name}`
  }
  return `Couldn't send ${name}. Keep Orca open while a file is sending, then attach it again`
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

// Keep successfully uploaded files when a later pick/upload fails; only the failing chip is removed.
export async function uploadPickedNativeChatFiles(args: {
  canContinue?: () => boolean
  picked: AsyncIterable<PickedMobileFile>
  upload: (
    file: PickedMobileFile,
    transfer: { id: string; onProgress: (sentBytes: number) => void }
  ) => Promise<StoredNativeChatFile>
  nextId: () => string
  onPicked: (file: PendingNativeChatFile) => void
  onProgress?: (id: string, sentBytes: number) => void
  onStored: (id: string, stored: StoredNativeChatFile) => void
  onFailed: (id: string) => void
  onError: (message: string) => void
}): Promise<void> {
  try {
    if (args.canContinue?.() === false) {
      return
    }
    for await (const file of args.picked) {
      if (args.canContinue?.() === false) {
        break
      }
      const id = args.nextId()
      args.onPicked({
        id,
        name: file.name,
        mime: file.mime,
        byteLength: file.byteLength,
        path: null,
        sentBytes: 0
      })
      try {
        args.onStored(
          id,
          await args.upload(file, {
            id,
            onProgress: (sentBytes) => args.onProgress?.(id, sentBytes)
          })
        )
      } catch (error) {
        args.onFailed(id)
        // Removing the chip mid-transfer is the user's own cancel, not a failure to report.
        if (!isAbortError(error)) {
          args.onError(nativeChatFileAttachFailureMessage(error, file.name))
        }
      }
      if (args.canContinue?.() === false) {
        break
      }
    }
  } catch (error) {
    args.onError(nativeChatFileAttachFailureMessage(error))
  }
}
