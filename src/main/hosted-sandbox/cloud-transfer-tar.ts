// Safe extraction for archives that come from a cloud VM: the VM is not trusted to produce a benign
// tar. Only regular files and directories are written; links, devices and any path that is absolute
// or climbs out of the destination are skipped; total bytes and entry counts are capped, and gzip is
// inflated with a byte cap (no gzip bombs).
import { createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'

const BLOCK = 512

export type TarExtractResult = {
  files: number
  dirs: number
  bytes: number
  /** Entries refused for safety (links, devices, escapes, symlinked ancestors). */
  skipped: string[]
  /** `noClobber`: a different file was already at the path; the transferred one was not written. */
  existing: string[]
  /** `noClobber`: the same content was already at the path (an earlier attempt wrote it). */
  identical: number
}

/** True when any existing ancestor of `relative` under `root` (or the entry itself) is a symlink. */
async function throughSymlink(root: string, relative: string): Promise<boolean> {
  let current = root
  for (const part of relative.split(sep)) {
    current = join(current, part)
    const info = await lstat(current).catch(() => null)
    if (!info) {
      return false
    }
    if (info.isSymbolicLink()) {
      return true
    }
  }
  return false
}

/** A relative, normalized path inside the destination, or null when the entry must be skipped. */
export function safeEntryPath(name: string): string | null {
  const cleaned = name
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
  if (!cleaned || cleaned === '.' || isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned)) {
    return null
  }
  const parts = cleaned.split('/')
  if (parts.some((part) => part === '..' || part === '' || part.includes('\0'))) {
    return null
  }
  // Never write git metadata (e.g. .git/hooks of a checkout the destination might be).
  if (parts.some((part) => part.toLowerCase() === '.git')) {
    return null
  }
  return normalize(parts.join(sep))
}

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const raw = block.subarray(offset, offset + length)
  if (raw[0]! & 0x80) {
    // GNU base-256 for huge sizes: refuse rather than trust it.
    return Number.POSITIVE_INFINITY
  }
  const text = readString(block, offset, length).trim()
  return text ? Number.parseInt(text, 8) : 0
}

function paxPath(data: Buffer): string | null {
  // Records are "<len> key=value\n" where <len> counts bytes (not characters) of the whole record.
  let path: string | null = null
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) {
      break
    }
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) {
      break
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    if (record.startsWith('path=')) {
      path = record.slice(5)
    }
    offset += length
  }
  return path
}

/**
 * Extracts a tar file into `destination`. `noClobber` skips files that already exist there (the
 * user's own files win over transferred ones).
 */
export async function safeExtractTar(
  tarPath: string,
  destination: string,
  options: { maxBytes: number; maxEntries?: number; noClobber?: boolean }
): Promise<TarExtractResult> {
  const maxEntries = options.maxEntries ?? 200_000
  await mkdir(destination, { recursive: true })
  const root = await realpath(destination)
  const handle = await open(tarPath, 'r')
  const result: TarExtractResult = {
    files: 0,
    dirs: 0,
    bytes: 0,
    skipped: [],
    existing: [],
    identical: 0
  }
  const header = Buffer.alloc(BLOCK)
  let offset = 0
  let longName: string | null = null
  let entries = 0
  try {
    for (;;) {
      const { bytesRead } = await handle.read(header, 0, BLOCK, offset)
      if (bytesRead < BLOCK || header.every((byte) => byte === 0)) {
        return result
      }
      offset += BLOCK
      if (++entries > maxEntries) {
        throw new Error('The transfer archive has too many entries.')
      }
      const size = readOctal(header, 124, 12)
      if (!Number.isFinite(size) || size < 0) {
        throw new Error('The transfer archive has an invalid entry size.')
      }
      const type = String.fromCharCode(header[156]!)
      const padded = Math.ceil(size / BLOCK) * BLOCK
      const prefix = readString(header, 345, 155)
      const rawName =
        longName ??
        (prefix ? `${prefix}/${readString(header, 0, 100)}` : readString(header, 0, 100))
      longName = null
      if (type === 'L' || type === 'x') {
        if (size > 64 * 1024) {
          throw new Error('The transfer archive has an oversized header.')
        }
        const data = Buffer.alloc(size)
        await handle.read(data, 0, size, offset)
        longName = type === 'L' ? readString(data, 0, size) : paxPath(data)
        offset += padded
        continue
      }
      if (type === 'g') {
        offset += padded
        continue
      }
      const relative = safeEntryPath(rawName)
      const regular = type === '0' || type === '\0' || type === '7'
      if (!relative || (!regular && type !== '5')) {
        result.skipped.push(rawName.slice(0, 200))
        offset += padded
        continue
      }
      const target = join(root, relative)
      if (type === '5') {
        // A directory entry may (oddly) carry data blocks: always step over them.
        offset += padded
        if (await throughSymlink(root, relative)) {
          result.skipped.push(rawName.slice(0, 200))
          continue
        }
        await mkdir(target, { recursive: true })
        result.dirs++
        continue
      }
      result.bytes += size
      if (result.bytes > options.maxBytes) {
        throw new Error('The transfer is larger than allowed.')
      }
      // A symlinked directory already in the destination (e.g. tracked in the branch) must not
      // redirect the write outside it: check every ancestor before creating anything.
      if (await throughSymlink(root, relative)) {
        result.skipped.push(rawName.slice(0, 200))
        offset += padded
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      // Never write through a symlink an earlier step (or the user) left at the path.
      const existing = await lstat(target).catch(() => null)
      if (existing && !existing.isFile()) {
        result.skipped.push(rawName.slice(0, 200))
        offset += padded
        continue
      }
      // Keep the executable bit (scripts); never setuid/setgid or group/world-writable.
      const executable = (readOctal(header, 100, 8) & 0o111) !== 0
      // Written to a fresh temp name first ('wx': never an existing path), then put in place, so a
      // failure mid-write never leaves a partial file at the real path.
      const temp = `${target}.orca-transfer-${randomBytes(6).toString('hex')}`
      const out = await open(temp, 'wx', executable ? 0o755 : 0o644)
      try {
        let remaining = size
        let position = offset
        const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)))
        while (remaining > 0) {
          const length = Math.min(chunk.length, remaining)
          const read = await handle.read(chunk, 0, length, position)
          if (read.bytesRead === 0) {
            throw new Error('The transfer archive is truncated.')
          }
          await out.write(chunk.subarray(0, read.bytesRead))
          remaining -= read.bytesRead
          position += read.bytesRead
        }
      } catch (error) {
        await out.close().catch(() => undefined)
        await unlink(temp).catch(() => undefined)
        throw error
      }
      await out.close()
      offset += padded
      if (existing && options.noClobber) {
        if (existing.size === size && (await sameContent(temp, target))) {
          result.identical++
        } else {
          result.existing.push(relative)
        }
        await unlink(temp)
        continue
      }
      if (options.noClobber) {
        // link() fails if something appeared at the path meanwhile: atomic no-clobber.
        try {
          await link(temp, target)
        } catch {
          result.existing.push(relative)
          await unlink(temp)
          continue
        }
        await unlink(temp)
      } else {
        await rename(temp, target)
      }
      result.files++
      continue
    }
  } finally {
    await handle.close()
  }
}

/** Inflates a .gz to a file, refusing past `maxBytes` of output (gzip-bomb guard). */
export async function gunzipCapped(
  source: string,
  destination: string,
  maxBytes: number
): Promise<number> {
  let total = 0
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength
      callback(total > maxBytes ? new Error('The transfer is larger than allowed.') : null, chunk)
    }
  })
  try {
    await pipeline(createReadStream(source), createGunzip(), cap, createWriteStream(destination))
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  }
  return total
}

async function sameContent(a: string, b: string): Promise<boolean> {
  // Only reached for files of equal size; transfers are capped, so reading both is bounded.
  const [left, right] = await Promise.all([readFile(a), readFile(b)])
  return left.equals(right)
}
