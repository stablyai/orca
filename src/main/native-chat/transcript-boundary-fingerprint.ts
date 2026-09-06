import type { TranscriptFileSource } from './transcript-file-source'

export async function readTranscriptBoundaryFingerprint(
  filePath: string,
  offset: number,
  fileSource: TranscriptFileSource
): Promise<string> {
  if (offset <= 0) {
    return ''
  }
  const start = Math.max(0, offset - 64)
  const reader = await fileSource.open(filePath)
  try {
    return (await reader.read(start, offset - start)).toString('base64')
  } finally {
    await reader.close()
  }
}
