import { bindOrcadCapturedRuntimeRequest } from './orcad-captured-runtime-request'
import {
  PTY_CAPTURED_DESTINATION_ACTIVATION_METHOD,
  PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD
} from '../../shared/pty-ownership-transfer-runtime-methods'
import {
  parseOrcadCatalogActivationRequest,
  parseOrcadCatalogActivationResult
} from './orcad-catalog-activation-contract'

export async function inspectRemoteOrcadCatalogActivation(options: {
  pairingCode: string
  request: Parameters<typeof parseOrcadCatalogActivationRequest>[0]
  signal: AbortSignal
  timeoutMs?: number
}) {
  options.signal.throwIfAborted()
  const expected = parseOrcadCatalogActivationRequest(options.request)
  const send = bindOrcadCapturedRuntimeRequest({
    ...options,
    runtimeId: expected.identity.destinationRuntimeId,
    errorPrefix: 'orcad_catalog_activation'
  })
  const support = (await send(PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD, {
    version: 1
  })) as Record<string, unknown> | null
  if (support?.version !== 1 || support.catalogActivation !== 1) {
    throw new Error('orcad_catalog_activation_negotiation_required')
  }
  return parseOrcadCatalogActivationResult(
    await send(PTY_CAPTURED_DESTINATION_ACTIVATION_METHOD, { version: 1, ...expected }),
    expected
  )
}
