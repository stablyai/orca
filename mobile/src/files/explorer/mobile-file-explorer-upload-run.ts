import {
  MobilePickedFileGoneError,
  type StagedMobileFile
} from '../../platform/media-picking/media-picker-contract'
import { isLogicalClientCutoverError } from '../../transport/connection/logical-client-cutover-error'
import { isRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { isFileExistsErrorMessage } from '../mutation-ownership/file-exists-error'
import { childPathOf, type ExplorerTarget } from './mobile-file-explorer-mutations'
import {
  firstFreeCopyName,
  uploadStagedFile,
  uploadStagedFileAsCopy,
  UploadUnconfirmedError
} from './mobile-file-explorer-upload'

export type UploadAttempt = {
  client: RpcClient
  target: ExplorerTarget
  file: StagedMobileFile
  parent: string
  name: string
  keepBoth: boolean
}

/** How one try ended; the queue decides what the row does next. */
export type UploadVerdict =
  | { kind: 'uploaded'; relativePath: string }
  | { kind: 'lost' }
  | { kind: 'clash'; copyName: string | undefined }
  /** The commit got no answer: the row asks the user to check, and the folder refreshes. */
  | { kind: 'unconfirmed'; message: string }
  /** Cut before the commit went out, so the host kept nothing; `transport` cuts may start over. */
  | { kind: 'cut'; message: string; transport: boolean }

function transportCut(error: unknown, message: string): boolean {
  return (
    isLogicalClientCutoverError(error) ||
    isRpcDeliveryUnknown(error) ||
    message.includes('staged_save_unknown')
  )
}

export async function runUpload(
  attempt: UploadAttempt,
  progress: (sentBytes: number) => void
): Promise<UploadVerdict> {
  const { client, target, file, parent } = attempt
  try {
    if (attempt.keepBoth) {
      return {
        kind: 'uploaded',
        relativePath: await uploadStagedFileAsCopy(client, target, file, parent, { progress })
      }
    }
    const relativePath = childPathOf(parent, attempt.name)
    await uploadStagedFile(client, target, file, relativePath, { progress })
    return { kind: 'uploaded', relativePath }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof MobilePickedFileGoneError) {
      return { kind: 'lost' }
    }
    if (error instanceof UploadUnconfirmedError) {
      return { kind: 'unconfirmed', message }
    }
    if (!attempt.keepBoth && isFileExistsErrorMessage(message)) {
      return {
        kind: 'clash',
        copyName: await firstFreeCopyName(client, target, parent, attempt.name)
      }
    }
    return { kind: 'cut', message, transport: transportCut(error, message) }
  }
}
