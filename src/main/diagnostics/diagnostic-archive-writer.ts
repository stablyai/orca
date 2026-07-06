import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  DiagnosticBundleCategory,
  DiagnosticBundleFileManifest,
  DiagnosticBundleManifest
} from '../../shared/diagnostic-bundle-export-types'

export type DiagnosticArchiveEntry = {
  category: DiagnosticBundleCategory
  path: string
  content: Buffer | string
}

type PreparedEntry = {
  category: DiagnosticBundleCategory | 'manifest'
  path: string
  content: Buffer
  crc32: number
  sha256: string
}

const CRC32_TABLE = new Uint32Array(256)
for (let i = 0; i < CRC32_TABLE.length; i += 1) {
  let value = i
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC32_TABLE[i] = value >>> 0
}

export async function writeDiagnosticArchive(args: {
  outputPath: string
  manifest: Omit<DiagnosticBundleManifest, 'files'>
  entries: readonly DiagnosticArchiveEntry[]
}): Promise<{ bytes: number; manifest: DiagnosticBundleManifest }> {
  const prepared = args.entries.map(prepareEntry)
  const fileManifest = prepared.map(toManifestEntry)
  const manifest: DiagnosticBundleManifest = {
    ...args.manifest,
    files: [
      {
        path: 'manifest.json',
        category: 'manifest',
        bytes: 0,
        sha256: null
      },
      ...fileManifest
    ]
  }
  let finalManifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  let previousManifestBytes = -1
  while (finalManifestContent.byteLength !== previousManifestBytes) {
    previousManifestBytes = finalManifestContent.byteLength
    manifest.files[0] = {
      path: 'manifest.json',
      category: 'manifest',
      bytes: previousManifestBytes,
      sha256: null
    }
    finalManifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
  const manifestEntry: PreparedEntry = {
    category: 'manifest',
    path: 'manifest.json',
    content: finalManifestContent,
    crc32: crc32(finalManifestContent),
    sha256: createHash('sha256').update(finalManifestContent).digest('hex')
  }
  const archiveBytes = buildZip([manifestEntry, ...prepared])
  await mkdir(dirname(args.outputPath), { recursive: true })
  await writeFile(args.outputPath, archiveBytes)
  return { bytes: archiveBytes.byteLength, manifest }
}

function prepareEntry(entry: DiagnosticArchiveEntry): PreparedEntry {
  const path = normalizeArchivePath(entry.path)
  const content = Buffer.isBuffer(entry.content)
    ? entry.content
    : Buffer.from(entry.content, 'utf8')
  return {
    category: entry.category,
    path,
    content,
    crc32: crc32(content),
    sha256: createHash('sha256').update(content).digest('hex')
  }
}

function toManifestEntry(entry: PreparedEntry): DiagnosticBundleFileManifest {
  return {
    path: entry.path,
    category: entry.category,
    bytes: entry.content.byteLength,
    sha256: entry.sha256
  }
}

function normalizeArchivePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('../') || normalized.startsWith('..')) {
    throw new Error(`invalid archive path: ${path}`)
  }
  return normalized
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(entries: readonly PreparedEntry[]): Buffer {
  const chunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(entry.crc32, 14)
    local.writeUInt32LE(entry.content.byteLength, 18)
    local.writeUInt32LE(entry.content.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, entry.content)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(entry.crc32, 16)
    central.writeUInt32LE(entry.content.byteLength, 20)
    central.writeUInt32LE(entry.content.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, name)

    offset += local.byteLength + name.byteLength + entry.content.byteLength
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, ...centralChunks, end])
}
