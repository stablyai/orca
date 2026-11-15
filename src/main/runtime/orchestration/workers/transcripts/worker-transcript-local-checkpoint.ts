import { open, stat } from 'node:fs/promises'
import {
  createWorkerTranscriptBoundaryCheckpoint,
  localWorkerTranscriptSourceIdentity,
  workerTranscriptBoundaryCheckpointStart,
  workerTranscriptSourceChanged,
  type WorkerTranscriptSourceIdentity
} from './worker-transcript-source-identity'

type LocalTranscriptHandle = Awaited<ReturnType<typeof open>>

export async function readLocalTranscriptSourceIdentity(
  filePath: string
): Promise<WorkerTranscriptSourceIdentity | null> {
  return localWorkerTranscriptSourceIdentity(await stat(filePath, { bigint: true }))
}

export async function readLocalTranscriptPathBoundaryCheckpoint(
  filePath: string,
  sourceIdentity: WorkerTranscriptSourceIdentity,
  offset: number
): Promise<string | null> {
  const handle = await open(filePath, 'r')
  try {
    const opened = localWorkerTranscriptSourceIdentity(await handle.stat({ bigint: true }))
    if (!opened || opened.fingerprint !== sourceIdentity.fingerprint || opened.size < offset) {
      return null
    }
    const checkpoint = await readLocalTranscriptHandleBoundaryCheckpoint(handle, offset)
    const handleAfter = localWorkerTranscriptSourceIdentity(await handle.stat({ bigint: true }))
    const pathAfter = await readLocalTranscriptSourceIdentity(filePath)
    return checkpoint &&
      !workerTranscriptSourceChanged(sourceIdentity, handleAfter, offset) &&
      !workerTranscriptSourceChanged(sourceIdentity, pathAfter, offset)
      ? checkpoint
      : null
  } finally {
    await handle.close()
  }
}

export async function readLocalTranscriptHandleBoundaryCheckpoint(
  handle: LocalTranscriptHandle,
  offset: number
): Promise<string | null> {
  const start = workerTranscriptBoundaryCheckpointStart(offset)
  const expectedBytes = offset - start
  const bytes = Buffer.allocUnsafe(expectedBytes)
  let bytesRead = 0
  while (bytesRead < expectedBytes) {
    const result = await handle.read(bytes, bytesRead, expectedBytes - bytesRead, start + bytesRead)
    if (result.bytesRead === 0) {
      return null
    }
    bytesRead += result.bytesRead
  }
  return createWorkerTranscriptBoundaryCheckpoint(bytes)
}

export async function localTranscriptOffsetStartsInsideRecord(
  handle: LocalTranscriptHandle,
  offset: number
): Promise<boolean> {
  if (offset === 0) {
    return false
  }
  const previousByte = Buffer.allocUnsafe(1)
  const { bytesRead } = await handle.read(previousByte, 0, 1, offset - 1)
  return bytesRead === 1 && previousByte[0] !== 0x0a
}
