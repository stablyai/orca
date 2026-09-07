import { MAX_FILE_RANGE_READ_BYTES } from '../../../shared/file-range-read'
import type { IFilesystemProvider } from '../../providers/types'
import {
  createWorkerTranscriptBoundaryCheckpoint,
  remoteWorkerTranscriptSourceIdentity,
  workerTranscriptBoundaryCheckpointStart,
  workerTranscriptSourceChanged,
  type WorkerTranscriptSourceIdentity
} from './worker-transcript-source-identity'

export type RemoteTranscriptWindow = {
  bytes: Buffer
  fileSize: number
  startOffset: number
  scanEnd: number
  startsInsideRecord: boolean
  boundaryPrefix: Buffer
  sourceIdentity: WorkerTranscriptSourceIdentity
}

export async function supportsRemoteTranscriptRangeRead(
  provider: IFilesystemProvider
): Promise<boolean> {
  if (!provider.readFileRange) {
    return false
  }
  return provider.supportsFileRangeRead ? provider.supportsFileRangeRead() : true
}

export async function readRemoteTranscriptBoundaryBytes(
  provider: IFilesystemProvider,
  filePath: string,
  offset: number
): Promise<Buffer | null> {
  const start = workerTranscriptBoundaryCheckpointStart(offset)
  const expectedBytes = offset - start
  const bytes = await readRemoteTranscriptRange(provider, filePath, start, expectedBytes)
  return bytes.length === expectedBytes ? bytes : null
}

export async function readRemoteTranscriptRangedWindow(args: {
  provider: IFilesystemProvider
  filePath: string
  requestedOffset?: number
  expectedBoundaryCheckpoint?: string
  maxScanBytes: number
}): Promise<RemoteTranscriptWindow | null> {
  const remoteStat = await args.provider.stat(args.filePath)
  const sourceIdentity = remoteWorkerTranscriptSourceIdentity(remoteStat)
  if (!sourceIdentity) {
    throw new Error('Remote transcript host did not provide stable file identity')
  }
  const fileSize = remoteStat.size
  const startOffset = args.requestedOffset ?? Math.max(0, fileSize - args.maxScanBytes)
  if (startOffset > fileSize) {
    return null
  }
  const scanEnd =
    args.requestedOffset === undefined
      ? fileSize
      : Math.min(fileSize, startOffset + args.maxScanBytes)
  const boundaryPrefix = await readRemoteTranscriptBoundaryBytes(
    args.provider,
    args.filePath,
    startOffset
  )
  if (!boundaryPrefix) {
    return null
  }
  const boundaryCheckpoint = createWorkerTranscriptBoundaryCheckpoint(boundaryPrefix)
  if (
    args.expectedBoundaryCheckpoint !== undefined &&
    boundaryCheckpoint !== args.expectedBoundaryCheckpoint
  ) {
    return null
  }
  const startsInsideRecord = boundaryPrefix.length > 0 && boundaryPrefix.at(-1) !== 0x0a
  const bytes = await readRemoteTranscriptRange(
    args.provider,
    args.filePath,
    startOffset,
    scanEnd - startOffset
  )
  if (bytes.length !== scanEnd - startOffset) {
    return null
  }
  const boundaryAfter = await readRemoteTranscriptBoundaryBytes(
    args.provider,
    args.filePath,
    startOffset
  )
  const after = remoteWorkerTranscriptSourceIdentity(await args.provider.stat(args.filePath))
  if (
    !boundaryAfter ||
    createWorkerTranscriptBoundaryCheckpoint(boundaryAfter) !== boundaryCheckpoint ||
    workerTranscriptSourceChanged(sourceIdentity, after, scanEnd)
  ) {
    return null
  }
  return {
    bytes,
    fileSize,
    startOffset,
    scanEnd,
    startsInsideRecord,
    boundaryPrefix,
    sourceIdentity
  }
}

export async function readRemoteTranscriptRange(
  provider: IFilesystemProvider,
  filePath: string,
  position: number,
  length: number
): Promise<Buffer> {
  const windows: Buffer[] = []
  let bytesRead = 0
  while (bytesRead < length) {
    const windowLength = Math.min(MAX_FILE_RANGE_READ_BYTES, length - bytesRead)
    const window = await provider.readFileRange!(filePath, position + bytesRead, windowLength)
    windows.push(window.bytes)
    bytesRead += window.bytesRead
    if (window.bytesRead < windowLength) {
      break
    }
  }
  return Buffer.concat(windows, bytesRead)
}
