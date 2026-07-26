import { stat } from 'node:fs/promises'

export type TranscriptFileVersion = {
  identity: string
  size: number
  mtimeMs: number
  ctimeMs: number
}

export async function readTranscriptFileVersion(filePath: string): Promise<TranscriptFileVersion> {
  const value = await stat(filePath)
  return {
    identity: `${value.dev}:${value.ino}`,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs
  }
}

export function transcriptFileVersionChanged(
  current: TranscriptFileVersion,
  previous: TranscriptFileVersion
): boolean {
  return (
    current.identity !== previous.identity ||
    current.size !== previous.size ||
    current.mtimeMs !== previous.mtimeMs ||
    current.ctimeMs !== previous.ctimeMs
  )
}
