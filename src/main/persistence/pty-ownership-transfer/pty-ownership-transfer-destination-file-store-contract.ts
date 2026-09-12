import { join } from 'node:path'

export const PTY_OWNERSHIP_TRANSFER_DESTINATION_DIRECTORY = 'pty-ownership-transfer-destination-v1'

export type DestinationFileStoreOptions = {
  directory: string
  catalogPublicationVersion?: 1
  maxRecords?: number
  maxInputIds?: number
  now?: () => Date
}

export function ptyOwnershipTransferDestinationDirectory(profileDirectory: string): string {
  return join(profileDirectory, PTY_OWNERSHIP_TRANSFER_DESTINATION_DIRECTORY)
}

export function boundedDestinationFileStoreValue(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('pty_ownership_transfer_destination_store_bound_invalid')
  }
  return Math.min(value, maximum)
}

export function destinationFileStoreErrorHasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

export function requireDestinationSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('pty_ownership_transfer_destination_cursor_invalid')
  }
}
