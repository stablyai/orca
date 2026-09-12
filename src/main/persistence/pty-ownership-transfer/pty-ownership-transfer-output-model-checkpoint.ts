/** Durable proof that one transfer frame fragment was admitted to the host model. */
export type PtyOwnershipTransferOutputModelCheckpoint = {
  ptyId: string
  frameSeq: number
  fragmentStartSu: number
  fragmentEndSu: number
  frameLengthSu: number
  data: string
  modelSequenceEnd: number
}

export const MAX_PTY_OWNERSHIP_TRANSFER_OUTPUT_MODEL_CHECKPOINTS = 4_096

export function parseModelCheckpoints(value: unknown): PtyOwnershipTransferOutputModelCheckpoint[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_output_model_checkpoints_invalid')
  }
  const checkpoints: PtyOwnershipTransferOutputModelCheckpoint[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      throw new Error('pty_ownership_transfer_output_model_checkpoint_invalid')
    }
    const ptyId = candidate.ptyId
    const frameSeq = candidate.frameSeq
    const fragmentStartSu = candidate.fragmentStartSu
    const fragmentEndSu = candidate.fragmentEndSu
    const frameLengthSu = candidate.frameLengthSu
    const data = candidate.data
    const modelSequenceEnd = candidate.modelSequenceEnd
    if (
      typeof ptyId !== 'string' ||
      ptyId.length === 0 ||
      ptyId.length > 512 ||
      !positiveSequence(frameSeq) ||
      !nonNegativeSequence(fragmentStartSu) ||
      !positiveSequence(fragmentEndSu) ||
      !positiveSequence(frameLengthSu) ||
      fragmentEndSu > frameLengthSu ||
      fragmentEndSu - fragmentStartSu <= 0 ||
      typeof data !== 'string' ||
      data.length !== fragmentEndSu - fragmentStartSu ||
      !positiveSequence(modelSequenceEnd)
    ) {
      throw new Error('pty_ownership_transfer_output_model_checkpoint_invalid')
    }
    const key = `${frameSeq}\0${fragmentStartSu}`
    if (seen.has(key)) {
      throw new Error('pty_ownership_transfer_output_model_checkpoint_duplicate')
    }
    seen.add(key)
    bytes += Buffer.byteLength(data, 'utf8')
    if (bytes > 4 * 1024 * 1024) {
      throw new Error('pty_ownership_transfer_output_model_checkpoints_too_large')
    }
    checkpoints.push({
      ptyId,
      frameSeq: Number(frameSeq),
      fragmentStartSu: Number(fragmentStartSu),
      fragmentEndSu: Number(fragmentEndSu),
      frameLengthSu: Number(frameLengthSu),
      data,
      modelSequenceEnd: Number(modelSequenceEnd)
    })
  }
  return checkpoints
}

export function validateOutputModelCheckpoint(
  value: unknown
): PtyOwnershipTransferOutputModelCheckpoint {
  return parseModelCheckpoints([value])[0]
}

export function sameModelCheckpoint(
  left: PtyOwnershipTransferOutputModelCheckpoint,
  right: PtyOwnershipTransferOutputModelCheckpoint
): boolean {
  return (
    left.ptyId === right.ptyId &&
    left.frameSeq === right.frameSeq &&
    left.fragmentStartSu === right.fragmentStartSu &&
    left.fragmentEndSu === right.fragmentEndSu &&
    left.frameLengthSu === right.frameLengthSu &&
    left.data === right.data &&
    left.modelSequenceEnd === right.modelSequenceEnd
  )
}

function positiveSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
