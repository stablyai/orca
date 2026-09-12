import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

export function runtimeEnvironmentRevisionFailure(
  environment: KnownRuntimeEnvironment,
  expectedPairingRevision: number | undefined,
  method: string
): RuntimeRpcResponse<never> | null {
  if (
    expectedPairingRevision === undefined ||
    (environment.pairingRevision ?? environment.createdAt) === expectedPairingRevision
  ) {
    return null
  }
  return runtimeEnvironmentChangedFailure(environment, method)
}

export function runtimeEnvironmentChangedFailure(
  environment: Pick<KnownRuntimeEnvironment, 'runtimeId'>,
  method: string
): RuntimeRpcResponse<never> {
  return {
    id: method,
    ok: false,
    error: {
      code: 'runtime_environment_changed',
      message: 'Runtime environment pairing changed; refresh and try again'
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}
