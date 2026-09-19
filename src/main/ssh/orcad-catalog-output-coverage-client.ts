import { bindOrcadCapturedRuntimeRequest } from './orcad-captured-runtime-request'
import {
  PTY_CAPTURED_DESTINATION_OUTPUT_COVERAGE_METHOD,
  PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD
} from '../../shared/pty-ownership-transfer-runtime-methods'
import {
  parseOrcadCatalogOutputCoverageRequest,
  parseOrcadCatalogOutputCoverageResult
} from './orcad-catalog-output-coverage-contract'

export async function inspectRemoteOrcadCatalogOutputCoverage(options: {
  pairingCode: string
  request: Parameters<typeof parseOrcadCatalogOutputCoverageRequest>[0]
  signal: AbortSignal
  timeoutMs?: number
}) {
  options.signal.throwIfAborted()
  const expected = parseOrcadCatalogOutputCoverageRequest(options.request)
  const send = bindOrcadCapturedRuntimeRequest({
    ...options,
    runtimeId: expected.identity.destinationRuntimeId,
    errorPrefix: 'orcad_catalog_output_coverage'
  })
  const support = (await send(PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD, {
    version: 1
  })) as Record<string, unknown> | null
  if (support?.version !== 1 || support.catalogOutputCoverage !== 1) {
    throw new Error('orcad_catalog_output_coverage_negotiation_required')
  }
  return parseOrcadCatalogOutputCoverageResult(
    await send(PTY_CAPTURED_DESTINATION_OUTPUT_COVERAGE_METHOD, { version: 1, ...expected }),
    expected
  )
}
