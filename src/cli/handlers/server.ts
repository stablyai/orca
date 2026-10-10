import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getDefaultUserDataPath, RuntimeClientError } from '../runtime-client'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import { addEnvironmentFromPairingCode, type EnvironmentAddResult } from '../runtime/environments'
import { parseTtlMs, resolvePairingCodeInput } from '../runtime/pairing-code-input'

export const SERVER_HANDLERS: Record<string, CommandHandler> = {
  // Why: pairing URLs are minted from the server's own runtime state, so a routed
  // answer would describe a different machine than the one the URL pairs.
  'server link': async ({ client, flags, json }) => {
    rejectRemoteSelectionFlags(
      flags,
      '`orca server link`. The URL is minted from the server machine\u2019s own runtime state, so a routed answer would pair a different machine.',
      {
        nextSteps: [
          'Run `orca server link` on the server machine itself.',
          'Drop the flag to link this machine.'
        ]
      }
    )
    const params: Record<string, unknown> = {}
    if (flags.get('rotate') === true) {
      params.rotate = true
    }
    const ttlFlag = flags.get('ttl')
    if (typeof ttlFlag === 'string' && ttlFlag.length > 0) {
      params.ttlMs = parseTtlMs(ttlFlag)
    }
    const address = flags.get('address')
    if (typeof address === 'string' && address.length > 0) {
      params.address = address
    }
    const reach = flags.get('reach')
    if (typeof reach === 'string' && reach.length > 0) {
      if (reach !== 'network' && reach !== 'this-computer') {
        throw new RuntimeClientError(
          'invalid_argument',
          `Invalid --reach "${reach}". Use network or this-computer.`
        )
      }
      params.reach = reach
    }

    const response = await client.call<{
      available: boolean
      pairingUrl?: string
      webClientUrl?: string
      endpoint?: string
      deviceId?: string
      reason?: string
      guidance?: string
    }>('mobile.getRuntimePairingUrl', params)

    const result = response.result
    if (!result.available) {
      // Reason strings are stable contract values; no URL may ever appear here.
      const parts = ['Pairing is unavailable.']
      if (result.reason) {
        parts.push(`Reason: ${result.reason}.`)
      }
      if (result.guidance) {
        parts.push(result.guidance)
      }
      throw new RuntimeClientError('runtime_error', parts.join(' '))
    }

    printResult(
      localSuccess({
        schemaVersion: 1,
        pairingUrl: result.pairingUrl,
        webClientUrl: result.webClientUrl,
        endpoint: result.endpoint,
        deviceId: result.deviceId
      }),
      json,
      (linked) =>
        `Pair this client with device ${linked.deviceId} at ${linked.endpoint}: ${linked.pairingUrl}`
    )
  },
  // Why: positionalArgs maps `<url-or-code>` onto the pairing-code flag slot, so the
  // positional and --pairing-code are one source here and file/stdin are the others.
  'server add': async ({ flags, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const pairingCode = await resolvePairingCodeInput({ flags })
    let environment
    try {
      environment = redactRuntimeEnvironment(
        addEnvironmentFromPairingCode(getDefaultUserDataPath(), { name, pairingCode })
      )
    } catch (error) {
      throw wrapSecretLeak(error, pairingCode)
    }
    printResult(
      localSuccess({ environment }),
      json,
      (result: EnvironmentAddResult) =>
        `Saved environment ${result.environment.name} (${result.environment.id}).`
    )
  }
}

// Why: store errors can embed the raw pairing code; strip it before the error
// reaches output so the secret never prints.
function wrapSecretLeak(error: unknown, pairingCode: string): Error {
  if (error instanceof Error && pairingCode.length > 0 && error.message.includes(pairingCode)) {
    return new RuntimeClientError(
      error instanceof RuntimeClientError ? error.code : 'invalid_argument',
      error.message.split(pairingCode).join('<pairing-code>')
    )
  }
  return error instanceof Error ? error : new Error(String(error))
}

function getRequiredStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
  }
  return value
}

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: {
      runtimeId: 'local'
    }
  }
}
