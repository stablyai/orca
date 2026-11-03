import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

type PairingCreateOfferResult =
  | {
      available: false
      reason: string
      guidance: string
    }
  | {
      available: true
      pairingUrl: string
      endpoint: string
      deviceId: string
      webClientUrl: string | null
    }

export const PAIRING_HANDLERS: Record<string, CommandHandler> = {
  'pairing create': async ({ flags, client, json }) => {
    const scopeFlag = flags.get('scope')
    const scope =
      typeof scopeFlag === 'string' && scopeFlag.length > 0
        ? parsePairingScope(scopeFlag)
        : undefined
    const address = optionalStringFlag(flags, 'address')
    const name = optionalStringFlag(flags, 'name')
    const result = await client.call<PairingCreateOfferResult>('pairing.createOffer', {
      ...(address ? { address } : {}),
      ...(name ? { name } : {}),
      ...(flags.get('rotate') === true ? { rotate: true } : {}),
      ...(scope ? { scope } : {})
    })
    if (!result.result.available) {
      throw new RuntimeClientError(
        'runtime_error',
        `${result.result.reason}: ${result.result.guidance}`
      )
    }
    printResult(result, json, formatPairingCreateOffer)
  }
}

function optionalStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  return value
}

function parsePairingScope(value: string): 'runtime' | 'mobile' {
  if (value === 'runtime' || value === 'mobile') {
    return value
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Invalid --scope value: ${value}. Expected runtime or mobile.`
  )
}

function formatPairingCreateOffer(result: PairingCreateOfferResult): string {
  if (!result.available) {
    return `${result.reason}: ${result.guidance}`
  }
  const lines = [
    `Pairing URL: ${result.pairingUrl}`,
    `Endpoint: ${result.endpoint}`,
    `Device ID: ${result.deviceId}`
  ]
  if (result.webClientUrl) {
    lines.push(`Web client URL: ${result.webClientUrl}`)
  }
  return lines.join('\n')
}
