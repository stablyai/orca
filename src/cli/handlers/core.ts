import type { CommandHandler } from '../dispatch'
import { formatCliStatus, formatStatus, printResult } from '../format'
import { RuntimeClientError, serveOrcaApp } from '../runtime-client'

function getOptionalServePort(flags: Map<string, string | boolean>): string | null {
  if (!flags.has('port')) {
    return null
  }
  const rawPort = flags.get('port')
  if (typeof rawPort !== 'string' || rawPort.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --port.')
  }
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RuntimeClientError('invalid_argument', `Invalid --port value: ${rawPort}`)
  }
  return rawPort
}

export const CORE_HANDLERS: Record<string, CommandHandler> = {
  open: async ({ client, json }) => {
    const result = await client.openOrca()
    printResult(result, json, formatCliStatus)
  },
  serve: async ({ flags, json }) => {
    if (flags.get('no-pairing') === true && flags.get('mobile-pairing') === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Use either --mobile-pairing or --no-pairing, not both.'
      )
    }
    const port = getOptionalServePort(flags)
    const exitCode = await serveOrcaApp({
      json,
      port,
      pairingAddress:
        typeof flags.get('pairing-address') === 'string'
          ? (flags.get('pairing-address') as string)
          : null,
      noPairing: flags.get('no-pairing') === true,
      mobilePairing: flags.get('mobile-pairing') === true
    })
    process.exitCode = exitCode
  },
  status: async ({ client, json }) => {
    const result = await client.getCliStatus()
    if (!json && !result.result.runtime.reachable) {
      process.exitCode = 1
    }
    printResult(result, json, formatStatus)
  }
}
