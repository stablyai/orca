import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import type { AESEncryptionKey } from 'expo-crypto'
import { joinUri } from '../mobile-web-shell/generation-cache-uri'
import type { GenerationFileSystem } from '../mobile-web-shell/generation-store-file-system'
import { deriveHostCacheKey } from '../mobile-web-shell/host-cache-key'
import {
  openDeviceStoreValue,
  type DeviceStoreTable,
  type DeviceStoreValueBinding
} from './device-store-seal'

// cache: <Caches>/orca-store/v1 (purgeable, never backed up); draft: <Documents>/orca-drafts/v1.
export type DeviceStoreRoots = Readonly<Record<DeviceStoreTable, string>>

export const DEVICE_STORE_TABLES: readonly DeviceStoreTable[] = ['cache', 'draft']
export const DRAFT_TMP_SUFFIX = '.tmp'

export type DeviceStoreRow = DeviceStoreValueBinding & { readonly uri: string }

// Disk shows only hashes: no host id, worktree or key ever lands in a path.
export function hostDirectoryUri(
  roots: DeviceStoreRoots,
  table: DeviceStoreTable,
  hostId: string
): string {
  return joinUri(roots[table], deriveHostCacheKey(hostId))
}

// 256 buckets per host: one directory listing is synchronous JSI and can't be split, so the launch seed
// lists one small bucket per idle slice instead of one host directory of thousands of files.
const BUCKET_HEX_CHARS = 2
// Known in advance, so the seed never lists a host directory of 256 entries in one blocking call.
export const DEVICE_STORE_BUCKETS: readonly string[] = Array.from({ length: 256 }, (_, at) =>
  at.toString(16).padStart(BUCKET_HEX_CHARS, '0')
)

export function deviceStoreRows(
  roots: DeviceStoreRoots,
  hostId: string,
  table: DeviceStoreTable,
  keys: readonly string[]
): DeviceStoreRow[] {
  const hostUri = hostDirectoryUri(roots, table, hostId)
  return keys.map((key) => {
    const name = bytesToHex(sha256(key))
    return { hostId, table, key, uri: joinUri(hostUri, name.slice(0, BUCKET_HEX_CHARS), name) }
  })
}

// Null for absence; a file that fails its tag is torn or moved, so it is deleted and reads as a miss.
// Drafts prefer a decrypting .tmp: it is always newer, since a crash fell between its write and the move.
export async function readDeviceStoreRow(
  fs: GenerationFileSystem,
  cryptoKey: AESEncryptionKey,
  row: DeviceStoreRow
): Promise<{ value: string; bytes: number } | null> {
  if (row.table === 'draft') {
    const tmpUri = row.uri + DRAFT_TMP_SUFFIX
    const tmpBytes = await fs.readBytes(tmpUri)
    if (tmpBytes) {
      const value = await openDeviceStoreValue(cryptoKey, row, tmpBytes)
      if (value !== null) {
        await fs.delete(row.uri)
        await fs.moveFile(tmpUri, row.uri)
        return { value, bytes: tmpBytes.byteLength }
      }
      await fs.delete(tmpUri)
    }
  }
  const bytes = await fs.readBytes(row.uri)
  if (!bytes) {
    return null
  }
  const value = await openDeviceStoreValue(cryptoKey, row, bytes)
  if (value === null) {
    await fs.delete(row.uri)
    return null
  }
  return { value, bytes: bytes.byteLength }
}

// Cache rows are written in place (a torn write reads as a miss). Draft rows must never come back as
// nothing, and SDK 55 File.move can't overwrite, so: write .tmp, delete the target, move .tmp over it.
export async function writeDeviceStoreRow(
  fs: GenerationFileSystem,
  row: DeviceStoreRow,
  sealed: Uint8Array | null
): Promise<void> {
  if (row.table === 'cache') {
    await (sealed ? fs.writeBytes(row.uri, sealed) : fs.delete(row.uri))
    return
  }
  const tmpUri = row.uri + DRAFT_TMP_SUFFIX
  if (!sealed) {
    await fs.delete(tmpUri)
    await fs.delete(row.uri)
    return
  }
  // A lone .tmp left by a crash is the only copy until upkeep promotes it; keep it before reusing the name.
  if (await fs.fileExists(tmpUri)) {
    await promoteLoneDraftTmp(fs, tmpUri)
  }
  await fs.writeBytes(tmpUri, sealed)
  await fs.delete(row.uri)
  await fs.moveFile(tmpUri, row.uri)
}

// The launch sweep can't check a .tmp's tag (disk holds only hashes, not the binding). The target is
// deleted only after the .tmp write finished, so a lone .tmp is the whole value and becomes the target.
// Beside its target it may be torn, and the reader settles it. Returns the target it promoted to.
export async function promoteLoneDraftTmp(
  fs: GenerationFileSystem,
  tmpUri: string
): Promise<string | null> {
  const target = tmpUri.slice(0, -DRAFT_TMP_SUFFIX.length)
  if (await fs.fileExists(target)) {
    return null
  }
  await fs.moveFile(tmpUri, target)
  return target
}
