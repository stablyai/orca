import type { SshPtyDataCallback } from './ssh-pty-provider-contract'

export type SshPtySourceFrame = NonNullable<Parameters<SshPtyDataCallback>[0]['source']>

const SOURCE_KEYS = [
  'deliveryToken',
  'clientGeneration',
  'ownerGeneration',
  'sourceEndSu',
  'sourceLengthSu',
  'ptyIncarnation'
] as const

export function parseSshPtySourceFrame(
  params: Record<string, unknown>,
  data: string,
  relayPtyId: string
): Readonly<{ source?: SshPtySourceFrame; malformed: boolean }> {
  if (!SOURCE_KEYS.some((key) => params[key] !== undefined)) {
    return Object.freeze({ malformed: false })
  }
  const sourceEndSu = params.sourceEndSu
  const sourceLengthSu = params.sourceLengthSu
  const rawLength = params.rawLength
  const transformed = params.transformed === true
  if (
    typeof params.data !== 'string' ||
    typeof params.deliveryToken !== 'string' ||
    params.deliveryToken.length === 0 ||
    !positiveSafeInteger(params.clientGeneration) ||
    !positiveSafeInteger(params.ownerGeneration) ||
    !nonNegativeSafeInteger(sourceEndSu) ||
    !nonNegativeSafeInteger(sourceLengthSu) ||
    sourceEndSu < sourceLengthSu ||
    typeof params.ptyIncarnation !== 'string' ||
    params.ptyIncarnation.length === 0 ||
    (params.seq !== undefined && !nonNegativeSafeInteger(params.seq)) ||
    (transformed ? rawLength !== sourceLengthSu : data.length !== sourceLengthSu) ||
    (rawLength !== undefined && rawLength !== sourceLengthSu)
  ) {
    return Object.freeze({ malformed: true })
  }
  const sourceStartSu = sourceEndSu - sourceLengthSu
  return Object.freeze({
    malformed: false,
    source: Object.freeze({
      relayPtyId,
      spanId: `${params.deliveryToken}:${sourceStartSu}:${sourceEndSu}`,
      clientGeneration: params.clientGeneration,
      ownerGeneration: params.ownerGeneration,
      deliveryToken: params.deliveryToken,
      sourceStartSu,
      sourceEndSu
    })
  })
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
