import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Store } from '../../../persistence'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { getProvider } from '../provider/registry'
import { makePaneSpawnReservationKey, paneSpawnReservationsByOwnerKey } from './spawn-reservation'
import {
  attachStablePaneOwner,
  resolveStablePaneOwner,
  stablePaneAdoptionsByOwnerKey
} from './stable-owner'
import type { AdoptStablePaneArgs, AdoptStablePaneResult } from '../ipc/spawn-types'

export async function adoptStablePane(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  args: AdoptStablePaneArgs
): Promise<AdoptStablePaneResult | null> {
  const paneKey = makePaneKey(args.tabId, args.leafId)
  const ownerKey = makePaneSpawnReservationKey(args.worktreeId, args.connectionId, paneKey)
  const pendingAdoption = ownerKey ? stablePaneAdoptionsByOwnerKey.get(ownerKey) : undefined
  if (pendingAdoption) {
    return await pendingAdoption
  }
  const activePaneSpawn =
    ownerKey && !args.ownsPaneSpawnReservation
      ? paneSpawnReservationsByOwnerKey.get(ownerKey)
      : undefined
  if (activePaneSpawn) {
    const result = await activePaneSpawn.promise
    const owner = resolveStablePaneOwner(
      runtime,
      store,
      paneKey,
      args.worktreeId,
      args.connectionId
    )
    if (
      !owner ||
      owner.ptyId !== result.id ||
      (owner.incarnationId !== undefined &&
        result.incarnationId !== undefined &&
        owner.incarnationId !== result.incarnationId)
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    return {
      result: {
        ...result,
        isReattach: true,
        ...(owner.incarnationId ? { incarnationId: owner.incarnationId } : {})
      },
      owner,
      materialized: true as const
    }
  }
  const owner = resolveStablePaneOwner(runtime, store, paneKey, args.worktreeId, args.connectionId)
  if (!owner) {
    return null
  }
  const adoption = attachStablePaneOwner({
    runtime,
    store,
    provider: getProvider(args.connectionId),
    spawnOptions: {
      cols: args.cols,
      rows: args.rows,
      cwd: args.cwd
    },
    owner,
    worktreeId: args.worktreeId,
    connectionId: args.connectionId,
    resolveOwner: () =>
      resolveStablePaneOwner(runtime, store, paneKey, args.worktreeId, args.connectionId)
  })
  if (!ownerKey) {
    return await adoption
  }
  stablePaneAdoptionsByOwnerKey.set(ownerKey, adoption)
  try {
    return await adoption
  } finally {
    if (stablePaneAdoptionsByOwnerKey.get(ownerKey) === adoption) {
      stablePaneAdoptionsByOwnerKey.delete(ownerKey)
    }
  }
}
