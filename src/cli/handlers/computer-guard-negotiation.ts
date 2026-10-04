import type { ComputerProviderCapabilities } from '../../shared/runtime-types'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'

export async function negotiateComputerGuard(
  client: RuntimeClient,
  method: 'click' | 'performSecondaryAction' | 'setValue',
  ifSnapshotId: string | undefined
): Promise<void> {
  if (ifSnapshotId === undefined) {
    return
  }
  let capabilities: ComputerProviderCapabilities
  try {
    capabilities = (await client.call<ComputerProviderCapabilities>('computer.capabilities', {}))
      .result
  } catch {
    throw new RuntimeClientError(
      'unsupported_capability',
      'This host cannot negotiate guarded actions'
    )
  }
  const guards = capabilities.guardedActions
  if (guards?.version !== 1 || guards.rpcVersion !== 1 || !guards.actions.includes(method)) {
    throw new RuntimeClientError(
      'unsupported_capability',
      'This host does not support guarded actions'
    )
  }
}
