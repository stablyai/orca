import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

export function runtimeEnvironmentRevisionFailure(
  environment: KnownRuntimeEnvironment,
  expectedPairingRevision: number | undefined,
  method: string,
  expectedRuntimeId?: string
): RuntimeRpcResponse<never> | null {
  const pairingChanged =
    expectedPairingRevision !== undefined &&
    (environment.pairingRevision ?? environment.createdAt) !== expectedPairingRevision
  const runtimeChanged =
    expectedRuntimeId !== undefined && environment.runtimeId !== expectedRuntimeId
  if (!pairingChanged && !runtimeChanged) {
    return null
  }
  return {
    id: method,
    ok: false,
    error: {
      code: 'runtime_environment_changed',
      message: pairingChanged
        ? 'Runtime environment pairing changed; refresh and try again'
        : 'Runtime environment identity changed; refresh and try again'
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}
