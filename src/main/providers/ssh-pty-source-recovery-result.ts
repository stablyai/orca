import type { PtySourceRecoveryResult } from '../../shared/pty-source-recovery-contract'

export function parseSshPtySourceRecoveryResult(
  value: unknown
): PtySourceRecoveryResult | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid SSH PTY source recovery response')
  }
  const input = value as Record<string, unknown>
  if (input.status === 'restoreRequired' && typeof input.reason === 'string') {
    return Object.freeze({ status: 'restoreRequired', reason: input.reason })
  }
  if (
    input.status !== 'pending' ||
    typeof input.deliveryToken !== 'string' ||
    input.deliveryToken.length === 0 ||
    typeof input.ptyIncarnation !== 'string' ||
    input.ptyIncarnation.length === 0 ||
    !positiveInteger(input.clientGeneration) ||
    !positiveInteger(input.ownerGeneration) ||
    !nonNegativeInteger(input.checkpointSourceEndSu) ||
    !nonNegativeInteger(input.recoveryEndSu) ||
    Number(input.recoveryEndSu) < Number(input.checkpointSourceEndSu)
  ) {
    throw new Error('Invalid SSH PTY source recovery response')
  }
  return Object.freeze({
    status: 'pending',
    deliveryToken: input.deliveryToken,
    ptyIncarnation: input.ptyIncarnation,
    clientGeneration: Number(input.clientGeneration),
    ownerGeneration: Number(input.ownerGeneration),
    checkpointSourceEndSu: Number(input.checkpointSourceEndSu),
    recoveryEndSu: Number(input.recoveryEndSu)
  })
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
