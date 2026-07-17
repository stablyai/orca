import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

import { extract, ReadEntry } from 'tar'

import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'

type SelectedTuple = SshRelaySelectedArtifact['tuple']

function normalizedTarPath(entry: ReadEntry): string {
  return entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path
}

function assertTarEntry(
  entry: ReadEntry,
  expected: ReadonlyMap<string, SelectedTuple['entries'][number]>,
  seen: Set<string>
): SelectedTuple['entries'][number] {
  const path = normalizedTarPath(entry)
  const declared = expected.get(path)
  if (!declared || seen.has(path)) {
    throw new Error(`SSH relay TAR has an extra or duplicate entry: ${path}`)
  }
  seen.add(path)
  const expectedType = declared.type === 'file' ? 'File' : 'Directory'
  if (
    entry.type !== expectedType ||
    entry.mode === undefined ||
    (entry.mode & 0o777) !== declared.mode
  ) {
    throw new Error(`SSH relay TAR type or mode mismatch: ${path}`)
  }
  if (declared.type === 'file' && entry.size !== declared.size) {
    throw new Error(`SSH relay TAR size mismatch: ${path}`)
  }
  return declared
}

async function decompressTar(
  archivePath: string,
  destination: NodeJS.WritableStream,
  signal: AbortSignal,
  chunkBytes: number
): Promise<void> {
  await pipeline(
    createReadStream(archivePath, { highWaterMark: chunkBytes }),
    createBrotliDecompress({ chunkSize: chunkBytes }),
    destination,
    { signal }
  )
}

export async function extractSshRelayTarBrotli({
  archivePath,
  outputDirectory,
  tuple,
  signal,
  chunkBytes
}: {
  archivePath: string
  outputDirectory: string
  tuple: SelectedTuple
  signal: AbortSignal
  chunkBytes: number
}): Promise<void> {
  const expected = new Map(tuple.entries.map((entry) => [entry.path, entry]))
  const seen = new Set<string>()
  const unpack = extract({
    cwd: outputDirectory,
    strict: true,
    preserveOwner: false,
    noChmod: false,
    unlink: false,
    filter: (_path, entry) => {
      if (!(entry instanceof ReadEntry)) {
        throw new Error('SSH relay TAR extraction requires a streamed archive entry')
      }
      assertTarEntry(entry, expected, seen)
      return true
    }
  })
  await decompressTar(archivePath, unpack, signal, chunkBytes)
  const missing = tuple.entries.find((entry) => !seen.has(entry.path))
  if (missing) {
    throw new Error(`SSH relay TAR is missing a declared entry: ${missing.path}`)
  }
}
