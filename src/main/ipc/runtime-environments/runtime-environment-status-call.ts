import type * as Rpc from '../../../shared/runtime-rpc-envelope'
import type { RuntimeEnvironmentSelectedPairing } from '../../../shared/runtime-environment-selected-pairing'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getRuntimeEnvironmentStatus } from './runtime-environment-status-probe'
import {
  requireWslHostWithoutStart,
  type ManagedRuntimeCallPreparation
} from './runtime-environment-managed-tunnel'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'

export type RuntimeEnvironmentCallOptions = {
  prepareRequest?: Rpc.RuntimeRequestPreparation
  signal?: AbortSignal
  expectedEnvironmentRuntimeId?: string
  preparation?: ManagedRuntimeCallPreparation
  /** A status call is told which pairing its probe selected. */
  observeStatusSelection?: (selected: RuntimeEnvironmentSelectedPairing) => void
}

/** A status call to a paired host, held to its caller's pairing fence. */
export async function callRuntimeEnvironmentStatus(
  userDataPath: string,
  selector: string,
  timeoutMs: number | undefined,
  expectedEnvironmentPairingRevision: number | undefined,
  options: RuntimeEnvironmentCallOptions | undefined
): Promise<Rpc.RuntimeRpcResponse<unknown>> {
  const method = 'status.get'
  const { observeStatusSelection, ...unobserved } = options ?? {}
  let statusOptions: typeof options = options && unobserved
  // Why: the status probe dials on its own, so a no-start caller's WSL host is checked first.
  if (options?.preparation) {
    const { preparation: _preparation, ...rest } = unobserved
    await requireWslHostWithoutStart(userDataPath, selector, options.preparation)
    statusOptions = rest
  }
  const environment = resolveEnvironment(userDataPath, selector)
  const failure = runtimeEnvironmentRevisionFailure(
    environment,
    expectedEnvironmentPairingRevision,
    method
  )
  return (
    failure ??
    getRuntimeEnvironmentStatus(
      userDataPath,
      selector,
      timeoutMs,
      statusOptions,
      expectedEnvironmentPairingRevision === undefined,
      observeStatusSelection
    )
  )
}
