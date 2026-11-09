import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { StoreRuntimeState } from './store-runtime-state'
import type { resolveHostId } from './session-host-partitions'
import type { PtyBindingFastLaneVerdict } from './pty-binding-fast-lane'

// No-op rollback still triggers writer-owned failure publication for a matching binding.
const MATCHING_BINDING_ROLLBACK = (): void => {}

export function isDurabilityOnlyMatch(verdict: PtyBindingFastLaneVerdict): boolean {
  return verdict.misses.length === 1 && verdict.misses[0] === 'not_durable'
}

export function durabilityOnlyBindingResult(hostId: ExecutionHostId): {
  value: true
  rollback: () => void
  writtenHostIds: ExecutionHostId[]
} {
  return { value: true, rollback: MATCHING_BINDING_ROLLBACK, writtenHostIds: [hostId] }
}

export function markPtyBindingSessionDirty(
  runtime: Pick<StoreRuntimeState, 'dirtyProfileStateDomains'>,
  hostId: ReturnType<typeof resolveHostId>
): void {
  runtime.dirtyProfileStateDomains?.add(
    hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
  )
}
