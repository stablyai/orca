import { opendirSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { join } from 'node:path'

export const SPEECH_MODEL_ARCHIVE_SCAN_MAX_ENTRIES = 32_768
export const SPEECH_MODEL_ARCHIVE_MAX_RETAINED_NAME_BYTES = 4 * 1024 * 1024
export const SPEECH_MODEL_VOCAB_SCAN_MAX_ENTRIES = 4_096

export type SpeechModelArchiveScanLimits = {
  maxEntries: number
  maxRetainedNameBytes: number
}

export type NestedSpeechModelDirectory = {
  directoryPath: string
  entryNames: string[]
}

export class SpeechModelDirectoryCapacityError extends Error {
  constructor(resource: string, limit: number) {
    super(`Speech model directory exceeded its ${resource} limit (${limit})`)
    this.name = 'SpeechModelDirectoryCapacityError'
  }
}

function resolveLimit(requested: number | undefined, maximum: number, name: string): number {
  if (requested === undefined) {
    return maximum
  }
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return Math.min(requested, maximum)
}

function estimateRetainedNameBytes(name: string): number {
  return name.length * 2 + 64
}

export async function findNestedSpeechModelDirectory(
  modelDir: string,
  expectedFiles: readonly string[],
  requestedLimits: Partial<SpeechModelArchiveScanLimits> = {}
): Promise<NestedSpeechModelDirectory | null> {
  const maxEntries = resolveLimit(
    requestedLimits.maxEntries,
    SPEECH_MODEL_ARCHIVE_SCAN_MAX_ENTRIES,
    'maxEntries'
  )
  const maxRetainedNameBytes = resolveLimit(
    requestedLimits.maxRetainedNameBytes,
    SPEECH_MODEL_ARCHIVE_MAX_RETAINED_NAME_BYTES,
    'maxRetainedNameBytes'
  )
  const expectedFileNames = new Set(expectedFiles)
  let scannedEntries = 0

  const rootDirectory = await opendir(modelDir, { bufferSize: 32 })
  for await (const entry of rootDirectory) {
    scannedEntries += 1
    if (scannedEntries > maxEntries) {
      throw new SpeechModelDirectoryCapacityError('entry count', maxEntries)
    }
    if (!entry.isDirectory()) {
      continue
    }

    const nestedDirectoryPath = join(modelDir, entry.name)
    const entryNames: string[] = []
    let retainedNameBytes = 0
    const nestedDirectory = await opendir(nestedDirectoryPath, { bufferSize: 32 })
    for await (const nestedEntry of nestedDirectory) {
      scannedEntries += 1
      if (scannedEntries > maxEntries) {
        throw new SpeechModelDirectoryCapacityError('entry count', maxEntries)
      }
      retainedNameBytes += estimateRetainedNameBytes(nestedEntry.name)
      if (retainedNameBytes > maxRetainedNameBytes) {
        throw new SpeechModelDirectoryCapacityError('retained name bytes', maxRetainedNameBytes)
      }
      entryNames.push(nestedEntry.name)
    }
    if (entryNames.some((name) => expectedFileNames.has(name))) {
      return { directoryPath: nestedDirectoryPath, entryNames }
    }
  }
  return null
}

function closeSpeechModelDirectory(directory: ReturnType<typeof opendirSync>): void {
  try {
    directory.closeSync()
  } catch {
    // The OS may already have closed a fully consumed directory stream.
  }
}

export function findSpeechModelBpeVocabFile(
  modelDir: string,
  requestedMaxEntries = SPEECH_MODEL_VOCAB_SCAN_MAX_ENTRIES
): string | undefined {
  const maxEntries = resolveLimit(
    requestedMaxEntries,
    SPEECH_MODEL_VOCAB_SCAN_MAX_ENTRIES,
    'maxEntries'
  )
  let directory: ReturnType<typeof opendirSync>
  try {
    directory = opendirSync(modelDir, { bufferSize: 32 })
  } catch {
    return undefined
  }

  let scannedEntries = 0
  try {
    while (scannedEntries < maxEntries) {
      const entry = directory.readSync()
      if (entry === null) {
        return undefined
      }
      scannedEntries += 1
      if (entry.name.endsWith('.vocab')) {
        return join(modelDir, entry.name)
      }
    }
    return undefined
  } finally {
    closeSpeechModelDirectory(directory)
  }
}
