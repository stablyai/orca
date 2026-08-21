import { readTranscriptSlice, wslGatedStat } from './wsl-transcript-fs-access'

const BOUNDARY_FINGERPRINT_BYTES = 64

export type TranscriptFileVersion = {
  identity: string
  size: number
  mtimeMs: number
  ctimeMs: number
}

export async function readTranscriptFileVersion(
  filePath: string,
  signal?: AbortSignal
): Promise<TranscriptFileVersion> {
  const value = await wslGatedStat(filePath, 'exact', signal)
  return {
    identity: `${value.dev}:${value.ino}`,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs
  }
}

export async function boundaryFingerprint(
  filePath: string,
  offset: number,
  signal?: AbortSignal
): Promise<string> {
  if (offset <= 0) {
    return ''
  }
  const start = Math.max(0, offset - BOUNDARY_FINGERPRINT_BYTES)
  const slice = await readTranscriptSlice(filePath, start, offset - start, 'exact', signal)
  return slice.toString('base64')
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
