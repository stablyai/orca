import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import {
  MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES,
  type MobileWebSourceControlCompareEntry
} from '../../../src/shared/mobile-web/source-control-history-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export function mobileWebCompareEntryPage(
  snapshot: Record<string, unknown>,
  allEntries: MobileWebSourceControlCompareEntry[],
  offset: number,
  limit: number
): MobileWebSourceControlCompareEntry[] {
  const entries = allEntries.slice(offset, offset + limit)
  while (
    entries.length > 0 &&
    encodedByteLength({ ...snapshot, entries }) >
      MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES - 8 * 1024
  ) {
    entries.pop()
  }
  if (
    offset < allEntries.length &&
    (entries.length === 0 ||
      encodedByteLength({ ...snapshot, entries }) >
        MOBILE_WEB_SOURCE_CONTROL_COMPARE_RESPONSE_MAX_BYTES - 8 * 1024)
  ) {
    throw new MobileWebBrokerError('too_large')
  }
  return entries
}

export function mobileWebBranchCompareRevision(
  snapshot: Record<string, unknown>,
  entries: MobileWebSourceControlCompareEntry[]
): string {
  const content = new TextEncoder().encode(JSON.stringify({ snapshot, entries }))
  return Buffer.from(sha256(content)).toString('hex')
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
