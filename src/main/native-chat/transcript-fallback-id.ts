const TRANSCRIPT_POSITION_WIDTH = 16

/** Stable JSONL position id shared by full reads and incremental tailing. */
export function transcriptFallbackId(filePath: string, byteOffset: number): string {
  return `${filePath}:${positionPart(byteOffset)}`
}

function positionPart(value: number): string {
  return value.toString().padStart(TRANSCRIPT_POSITION_WIDTH, '0')
}
