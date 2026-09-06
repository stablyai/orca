import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import type { MobileWebFileDirectoryEntry } from '../../../src/shared/mobile-web/bridge-operation-contract'

export function compareMobileWebDirectoryEntries(
  left: MobileWebFileDirectoryEntry,
  right: MobileWebFileDirectoryEntry
): number {
  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1
  }
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export function mobileWebDirectoryRevision(
  entries: MobileWebFileDirectoryEntry[],
  truncated: boolean
): string {
  const canonical = JSON.stringify({
    entries: entries.map((entry) => [entry.name, entry.isDirectory, entry.isSymlink]),
    truncated
  })
  return Buffer.from(sha256(new TextEncoder().encode(canonical))).toString('hex')
}
