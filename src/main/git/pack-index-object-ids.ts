import { open, readFile } from 'node:fs/promises'

/**
 * Read a pack's object ids straight from its `.idx`, with no Git child.
 *
 * Only version 2 is understood -- what every Git since 1.5.2 writes by default,
 * and what `pack-objects` wrote for every pack this is pointed at. Anything
 * else answers `undefined`, which callers treat as "leave this pack alone".
 * The id width comes from the caller, because a pack's own name already says
 * whether the repository hashes with SHA-1 or SHA-256.
 */

const IDX_V2_SIGNATURE = 0xff744f63
const IDX_V2_HEADER_BYTES = 8
const FANOUT_BYTES = 256 * 4

function objectCountOf(header: Buffer): number | undefined {
  if (
    header.length < IDX_V2_HEADER_BYTES + FANOUT_BYTES ||
    header.readUInt32BE(0) !== IDX_V2_SIGNATURE ||
    header.readUInt32BE(4) !== 2
  ) {
    return undefined
  }
  // The last fan-out entry counts every object whose first byte is <= 0xff.
  return header.readUInt32BE(IDX_V2_HEADER_BYTES + FANOUT_BYTES - 4)
}

/** Object count from the fixed-size header alone; never reads the whole index. */
export async function readPackIndexObjectCount(indexPath: string): Promise<number | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(indexPath, 'r')
    const header = Buffer.alloc(IDX_V2_HEADER_BYTES + FANOUT_BYTES)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return objectCountOf(header.subarray(0, bytesRead))
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function readPackIndexObjectIds(
  indexPath: string,
  hashHexLength: 40 | 64
): Promise<string[] | undefined> {
  let index: Buffer
  try {
    index = await readFile(indexPath)
  } catch {
    return undefined
  }
  const count = objectCountOf(index)
  const hashBytes = hashHexLength / 2
  const namesStart = IDX_V2_HEADER_BYTES + FANOUT_BYTES
  if (count === undefined || index.length < namesStart + count * hashBytes) {
    return undefined
  }
  const ids: string[] = []
  for (let entry = 0; entry < count; entry += 1) {
    const start = namesStart + entry * hashBytes
    ids.push(index.toString('hex', start, start + hashBytes))
  }
  return ids
}
