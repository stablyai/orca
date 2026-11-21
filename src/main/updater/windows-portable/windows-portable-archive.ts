import { mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, crc32 } from 'node:zlib'
import {
  isPortableUserDataPath,
  readFileRange,
  readPortableZipEntries,
  type PortableZipEntry,
  type PortableZipOptions
} from './windows-portable-zip-directory'

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const READ_CHUNK_BYTES = 256 * 1024

async function* readCompressedChunks(
  archiveHandle: FileHandle,
  dataOffset: number,
  compressedSize: number
): AsyncGenerator<Buffer, void, void> {
  let remaining = compressedSize
  let cursor = dataOffset
  while (remaining > 0) {
    const chunkSize = Math.min(remaining, READ_CHUNK_BYTES)
    const chunk = await readFileRange(archiveHandle, cursor, chunkSize)
    cursor += chunkSize
    remaining -= chunkSize
    yield chunk
  }
}

async function writeAllToFile(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
    if (bytesWritten <= 0) {
      throw new Error('Short write while extracting portable update entry')
    }
    offset += bytesWritten
  }
}

async function extractFileEntry(
  archiveHandle: FileHandle,
  entry: PortableZipEntry,
  outputPath: string
): Promise<void> {
  const localHeader = await readFileRange(archiveHandle, entry.localHeaderOffset, 30)
  if (localHeader.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`Invalid local ZIP header for ${entry.relativePath}`)
  }
  const nameLen = localHeader.readUInt16LE(26)
  const extraLen = localHeader.readUInt16LE(28)
  const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen

  await mkdir(dirname(outputPath), { recursive: true })
  const outHandle = await open(outputPath, 'wx')
  try {
    if (entry.compressedSize === 0 && entry.uncompressedSize === 0) {
      if (entry.crc32 !== 0) {
        throw new Error(`CRC mismatch for empty file ${entry.relativePath}`)
      }
      return
    }
    let actualSize = 0
    let actualCrc = 0
    const writeChunk = async (chunk: Buffer): Promise<void> => {
      if (actualSize + chunk.length > entry.uncompressedSize) {
        throw new Error(`Expanded size exceeded header for ${entry.relativePath}`)
      }
      await writeAllToFile(outHandle, chunk)
      actualSize += chunk.length
      actualCrc = crc32(chunk, actualCrc)
    }

    const source = Readable.from(
      readCompressedChunks(archiveHandle, dataOffset, entry.compressedSize)
    )
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        writeChunk(chunk).then(() => callback(), callback)
      }
    })

    if (entry.compressionMethod === 0) {
      await pipeline(source, sink)
    } else {
      await pipeline(source, createInflateRaw(), sink)
    }

    if (actualSize !== entry.uncompressedSize) {
      throw new Error(`Size mismatch for ${entry.relativePath}`)
    }
    if (actualCrc >>> 0 !== entry.crc32 >>> 0) {
      throw new Error(`CRC-32 mismatch for ${entry.relativePath}`)
    }
  } finally {
    await outHandle.close()
  }
}

export async function extractWindowsPortableArchive(
  archivePath: string,
  destinationDir: string,
  options: PortableZipOptions = {}
): Promise<void> {
  const archiveStat = await stat(archivePath)
  const handle = await open(archivePath, 'r')
  try {
    const entries = await readPortableZipEntries(handle, archiveStat.size, options)
    await mkdir(destinationDir, { recursive: true })
    for (const entry of entries) {
      if (!entry.relativePath || isPortableUserDataPath(entry.relativePath)) {
        continue
      }
      const outPath = join(destinationDir, ...entry.relativePath.split('/'))
      if (entry.isDirectory) {
        await mkdir(outPath, { recursive: true })
      } else {
        await extractFileEntry(handle, entry, outPath)
      }
    }
  } finally {
    await handle.close()
  }

  for (const rel of ['Orca.exe', join('resources', 'app.asar')]) {
    const info = await stat(join(destinationDir, rel)).catch(() => null)
    if (!info?.isFile()) {
      throw new Error(`Portable update archive is missing required file: ${rel}`)
    }
  }
  const marker = (
    await readFile(join(destinationDir, 'resources', 'package-type'), 'utf8').catch(() => '')
  ).trim()
  if (marker !== 'portable') {
    throw new Error('Portable update archive is missing a valid portable package-type marker')
  }
}
