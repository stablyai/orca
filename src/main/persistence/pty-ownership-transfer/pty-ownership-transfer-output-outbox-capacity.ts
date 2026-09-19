import { readdirSync } from 'node:fs'
import { destinationFileStoreErrorHasCode } from './pty-ownership-transfer-destination-file-store-contract'

export function requireOutputOutboxCapacity(directory: string, maxRecords: number): void {
  let records: string[] = []
  try {
    records = readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
  } catch (error) {
    if (!destinationFileStoreErrorHasCode(error, 'ENOENT')) {
      throw error
    }
  }
  if (records.length >= maxRecords) {
    throw new Error('pty_ownership_transfer_output_outbox_record_capacity')
  }
}

export function boundedPositive(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error('pty_ownership_transfer_output_outbox_limit_invalid')
  }
  return value
}
