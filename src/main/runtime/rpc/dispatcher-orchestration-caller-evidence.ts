import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import type { RpcRequest } from './core'

const UNATTESTED_CALLER = Object.freeze({ paneKey: '', launchToken: '' })

export function resolveRpcCallerEvidence(
  request: RpcRequest,
  params: unknown,
  legacyCoordinatorAuthority?: unknown
): OrchestrationCompatibilityEvidence | undefined {
  if (
    request.orchestrationCompatibilityEvidence ||
    legacyCoordinatorAuthority ||
    !request.method.startsWith('orchestration.')
  ) {
    return request.orchestrationCompatibilityEvidence
  }
  const values = params as Record<string, unknown>
  const terminalHandle = [values.callerTerminalHandle, values.from, values.terminal].find(
    (value): value is string => typeof value === 'string'
  )
  return { terminalHandle: terminalHandle ?? '', ...UNATTESTED_CALLER }
}
