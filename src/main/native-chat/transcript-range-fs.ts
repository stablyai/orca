export type TranscriptFileStamp = {
  size: number
  identity: string
  mtimeMs: number
  ctimeMs: number
  boundaryFingerprint?: string
}

export class TranscriptRangeReadInvalidatedError extends Error {
  constructor() {
    super('Transcript changed during remote read')
    this.name = 'TranscriptRangeReadInvalidatedError'
  }
}

export type TranscriptRangeFs = {
  stat(
    filePath: string,
    signal?: AbortSignal,
    captureBoundary?: boolean
  ): Promise<TranscriptFileStamp>
  read(filePath: string, position: number, length: number, signal?: AbortSignal): Promise<Buffer>
  assertStable(
    filePath: string,
    openingStamp: TranscriptFileStamp,
    signal?: AbortSignal
  ): Promise<void>
}
