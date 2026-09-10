import { defineMethod, type RpcAnyMethod } from '../core'
import {
  PairingGetEndpointsParamsSchema,
  PairingProvisionRelayParamsSchema
} from '../../../../shared/mobile-relay-credential-contract'
import { redactString } from '../../../observability/redactor'

const MAX_PAIRING_FAILURE_MESSAGE_LENGTH = 240

export const PAIRING_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'pairing.getEndpoints',
    params: PairingGetEndpointsParamsSchema,
    handler: async (params, ctx) => {
      const pairing = ctx.pairing
      if (!pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await invokePairingProvider(() => pairing.getEndpoints(params))
    }
  }),
  defineMethod({
    name: 'pairing.provisionRelay',
    params: PairingProvisionRelayParamsSchema,
    handler: async (params, ctx) => {
      const pairing = ctx.pairing
      if (!pairing) {
        throw new Error('pairing_context_unavailable')
      }
      return await invokePairingProvider(() => pairing.provisionRelay(params))
    }
  })
]

async function invokePairingProvider<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code =
      error instanceof Error &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'pairing_runtime_error'
    const diagnostic = redactPairingDiagnostic(`${code}: ${message}`)
    throw new Error(diagnostic.slice(0, MAX_PAIRING_FAILURE_MESSAGE_LENGTH))
  }
}

function redactPairingDiagnostic(value: string): string {
  const normalized = value
    .replaceAll(
      /\b(?:deviceToken|resumeToken|accessToken|refreshToken)\s*[:=]\s*[^\s,;]+/gi,
      '[redacted:labeled-kv]'
    )
    .replaceAll(/\s+/g, ' ')
    .trim()
  return redactString(normalized)
}
