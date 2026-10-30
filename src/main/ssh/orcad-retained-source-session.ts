import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { Store } from '../persistence'
import { appUserDataPath, hiddenRetainedSourceTargetIds } from './orcad-retained-source'

/** A hidden source's session goes with its repos: a window adopting it at startup brings closed tabs back (#33539). */
export function visibleSessionHostIds(
  store: Pick<Store, 'getSshTargets'>,
  hostIds: readonly ExecutionHostId[],
  getUserDataPath = appUserDataPath
): ExecutionHostId[] {
  const hidden = new Set(hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets()))
  return hostIds.filter((hostId) => {
    const parsed = parseExecutionHostId(hostId)
    return parsed?.kind !== 'ssh' || !hidden.has(parsed.targetId)
  })
}
