import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'
import { type SshRelayZipLimits, visitSshRelayZip } from './ssh-relay-artifact-zip-reader'

type SelectedTuple = SshRelaySelectedArtifact['tuple']

function zipLimits(tuple: SelectedTuple): SshRelayZipLimits {
  return {
    maximumArchiveBytes: tuple.archive.size,
    maximumEntries: tuple.entries.length,
    maximumExpandedBytes: tuple.archive.expandedSize,
    maximumFileBytes: Math.max(
      ...tuple.entries.map((entry) => (entry.type === 'file' ? entry.size : 0))
    ),
    maximumDepth: 32,
    maximumPathBytes: 240
  }
}

async function visitExpectedZip({
  archivePath,
  tuple,
  outputDirectory,
  signal
}: {
  archivePath: string
  tuple: SelectedTuple
  outputDirectory?: string
  signal: AbortSignal
}): Promise<void> {
  const expected = new Map(tuple.entries.map((entry) => [entry.path, entry]))
  const seen = new Set<string>()
  const result = await visitSshRelayZip(
    archivePath,
    zipLimits(tuple),
    async (actual, consume) => {
      const declared = expected.get(actual.path)
      if (!declared || seen.has(actual.path)) {
        throw new Error(`SSH relay ZIP has an extra or duplicate entry: ${actual.path}`)
      }
      seen.add(actual.path)
      if (
        actual.type !== declared.type ||
        actual.unixMode === null ||
        (actual.unixMode & 0o777) !== declared.mode
      ) {
        throw new Error(`SSH relay ZIP type or mode mismatch: ${actual.path}`)
      }
      if (declared.type === 'directory') {
        if (outputDirectory) {
          const outputPath = join(outputDirectory, ...actual.path.split('/'))
          await mkdir(outputPath, { recursive: true, mode: declared.mode })
          if (process.platform !== 'win32') {
            await chmod(outputPath, declared.mode)
          }
        }
        return
      }
      if (actual.size !== declared.size) {
        throw new Error(`SSH relay ZIP size mismatch: ${actual.path}`)
      }
      const outputPath = outputDirectory
        ? join(outputDirectory, ...actual.path.split('/'))
        : undefined
      if ((await consume({ outputPath, mode: declared.mode })) !== declared.sha256) {
        throw new Error(`SSH relay ZIP file integrity mismatch: ${actual.path}`)
      }
      if (outputPath && process.platform !== 'win32') {
        await chmod(outputPath, declared.mode)
      }
    },
    signal
  )
  const missing = tuple.entries.find((entry) => !seen.has(entry.path))
  if (missing) {
    throw new Error(`SSH relay ZIP is missing a declared entry: ${missing.path}`)
  }
  if (
    result.files !== tuple.archive.fileCount ||
    result.expandedBytes !== tuple.archive.expandedSize
  ) {
    throw new Error('SSH relay ZIP aggregate size or file count is inconsistent')
  }
}

export async function inspectSshRelayZip(options: {
  archivePath: string
  tuple: SelectedTuple
  signal: AbortSignal
}): Promise<void> {
  await visitExpectedZip(options)
}

export async function extractSshRelayZip(options: {
  archivePath: string
  outputDirectory: string
  tuple: SelectedTuple
  signal: AbortSignal
}): Promise<void> {
  await visitExpectedZip(options)
}
