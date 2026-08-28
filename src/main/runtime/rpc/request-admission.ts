import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { assertExpectedRuntimeTarget, type RuntimeTargetBinding } from './runtime-target-binding'
import { assertNotFencedByValidationLease } from './validation-lease-fence'

/** Everything a request must satisfy before any handler may mutate anything.
 *
 *  Both checks belong to the boundary rather than to any handler, and they are
 *  ordered: reaching the wrong RUNTIME at all outranks whether that runtime's
 *  worktree is leased. Target binding reads the RAW params, because schema
 *  parsing strips a field no individual method declares.
 */
export async function assertRequestAdmissible(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  effectiveParams: unknown,
  /** The dispatch options themselves: the transport's own user-data root travels
   *  with it, so a remote caller is never matched against this host's path. */
  origin?: { transport?: RuntimeTargetBinding; hostUserDataPath?: string }
): Promise<void> {
  assertExpectedRuntimeTarget(
    runtime,
    request.method,
    request.params,
    origin?.transport,
    origin?.hostUserDataPath
  )
  await assertNotFencedByValidationLease(runtime, request.method, effectiveParams)
}
