import type * as Rpc from '../../../shared/runtime-rpc-envelope'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  prepareManagedRuntimeRequest,
  type ManagedRuntimeCallPreparation
} from './runtime-environment-managed-tunnel'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'

type Expected = { pairingRevision: number | undefined; runtimeId: string | undefined }

/**
 * Prepares the server for a request and holds it to its caller's pairing fence. A recipe VM wake
 * this request asked for re-pairs the server; the caller's fence named the pairing before that
 * wake, so it is checked against the record from before it, and past the fence the request
 * expects the pairing its own wake made, whatever process now serves it. Any other change still
 * refuses the request.
 */
export async function prepareFencedRuntimeRequest(
  userDataPath: string,
  environmentId: string,
  method: string,
  preparation: ManagedRuntimeCallPreparation | undefined,
  expected: Expected,
  signal?: AbortSignal,
  /** A recipe VM wake this request waited through before its call slot: its fence is checked
   *  against the record from before that wake, as for a wake the request made itself. */
  heldWake?: { before: KnownRuntimeEnvironment; wokenPairingRevision: number | null }
): Promise<
  | { failure: Rpc.RuntimeRpcResponse<never> }
  | { failure: null; environment: KnownRuntimeEnvironment; expected: Expected }
> {
  // A stale caller is refused before its request can wake (and re-pair) a VM.
  const stale = runtimeEnvironmentRevisionFailure(
    heldWake?.before ?? resolveEnvironment(userDataPath, environmentId),
    expected.pairingRevision,
    method,
    expected.runtimeId
  )
  if (stale) {
    return { failure: stale }
  }
  const prepared = await prepareManagedRuntimeRequest(
    userDataPath,
    environmentId,
    preparation,
    method,
    signal
  )
  const { environment } = prepared
  const woken = prepared.wokenPairingRevision ?? heldWake?.wokenPairingRevision ?? null
  const before =
    prepared.wokenPairingRevision !== null ? prepared.before : (heldWake?.before ?? prepared.before)
  const failure =
    woken === null
      ? runtimeEnvironmentRevisionFailure(
          environment,
          expected.pairingRevision,
          method,
          expected.runtimeId
        )
      : (runtimeEnvironmentRevisionFailure(
          before,
          expected.pairingRevision,
          method,
          expected.runtimeId
        ) ??
        // Past its own wake, the request is held to exactly the pairing that wake made.
        runtimeEnvironmentRevisionFailure(environment, woken, method))
  if (failure) {
    return { failure }
  }
  return {
    failure: null,
    environment,
    expected:
      woken === null
        ? expected
        : {
            pairingRevision: expected.pairingRevision === undefined ? undefined : woken,
            // The resumed server may be a new process the saved record has not learned yet; the
            // new pairing already authenticates it.
            runtimeId: undefined
          }
  }
}
