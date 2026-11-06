import type { Store } from '../../../persistence/loading-store/store'
import type { PersistPtyBindingArgs } from '../../../persistence/loading-store/pty-binding-persistence'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import type { RuntimePtySpawnArgs } from './spawn-state'
import { stopReplacedPanePty } from '../ipc/renderer-kill'
import { stopReplacedPaneOwner, swapReplacedPaneBinding } from '../pane/pane-owner-replacement'
import { excludeReplacedPaneOwner, type ReplacedPaneOwner } from '../pane/replaced-pane-owner'
import { resolveStablePaneOwner, type StablePaneOwner } from '../pane/stable-owner'
import { ptyPaneKey } from '../pane/key-state'
import {
  makePaneSpawnReservationKey,
  rejectPaneSpawnReservation,
  reserveIdlePaneSpawn,
  type PaneSpawnReservation
} from '../pane/spawn-reservation'

/** The kill deps `stopReplacedPanePty` needs are a subset of the runtime controller's. */
export type RuntimePaneReplacementDeps = Pick<
  PtyRuntimeControllerDeps,
  | 'runtime'
  | 'store'
  | 'getLocalPtyProviderStartupPromise'
  | 'shutdownProviderAndDetectExit'
  | 'rememberSyntheticKillExit'
  | 'sendPtyExitToRenderer'
>

export type RuntimePaneReplacement = {
  reservationKey: string
  reservation: PaneSpawnReservation
  replaced: ReplacedPaneOwner
}

/**
 * The runtime twin of `ipc/spawn-run.ts`'s replacement: hold the pane across the stop, prove
 * `replacesPtyId` still owns it, stop it. The caller settles the reservation; a refusal stops nothing.
 */
export async function beginRuntimePaneReplacement(
  deps: RuntimePaneReplacementDeps,
  args: {
    replacesPtyId: string
    paneKey: string | null
    worktreeId: string | undefined
    connectionId: string | null | undefined
    reservation?: PaneSpawnReservation
  },
  stopReplacedPty: (id: string) => Promise<void> = (id) => stopReplacedPanePty(deps, id)
): Promise<RuntimePaneReplacement> {
  const reservationKey = makePaneSpawnReservationKey(
    args.worktreeId,
    args.connectionId,
    args.paneKey
  )
  if (!reservationKey) {
    throw new Error('terminal_pane_owner_unknown')
  }
  const reservation = args.reservation ?? (await reserveIdlePaneSpawn(reservationKey))
  try {
    // Why: upstream's stop proves the id only against a bound owner and stops an unproven id when the
    // pane is unbound; a move must never stop a stranger's PTY, so an unbound pane needs the id's
    // own pane-key record.
    const owner = resolveStablePaneOwner(
      deps.runtime,
      deps.store,
      args.paneKey,
      args.worktreeId,
      args.connectionId
    )
    if (!owner && ptyPaneKey.get(args.replacesPtyId) !== args.paneKey) {
      throw new Error('terminal_pane_owner_unknown')
    }
    const replaced = await stopReplacedPaneOwner(
      { runtime: deps.runtime, store: deps.store, stopReplacedPty },
      args
    )
    return { reservationKey, reservation, replaced }
  } catch (error) {
    rejectPaneSpawnReservation(reservationKey, reservation, error)
    throw error
  }
}

/** Why exclude: the replacement's own stop leaves its binding for the commit to swap, not to reattach. */
export function resolveRuntimeStablePaneOwner(ctx: {
  deps: Pick<PtyRuntimeControllerDeps, 'runtime' | 'store'>
  args: Pick<RuntimePtySpawnArgs, 'worktreeId' | 'connectionId'>
  spawnIdentityPaneKey: string | null
  replacedPaneOwner: ReplacedPaneOwner | null
}): StablePaneOwner | null {
  return excludeReplacedPaneOwner(
    resolveStablePaneOwner(
      ctx.deps.runtime,
      ctx.deps.store,
      ctx.spawnIdentityPaneKey,
      ctx.args.worktreeId,
      ctx.args.connectionId
    ),
    ctx.replacedPaneOwner
  )
}

/** A replacement binds through the swap (decided inside the durable write); any other spawn as before. */
export function runtimePaneBindingInput(
  store: Store,
  binding: PersistPtyBindingArgs,
  replaced: ReplacedPaneOwner | null
): PersistPtyBindingArgs | (() => PersistPtyBindingArgs | null) {
  return replaced ? swapReplacedPaneBinding(store, binding, replaced) : binding
}

export function runtimePaneBindRefusal(
  replaced: ReplacedPaneOwner | null
): 'terminal_pane_owner_changed' | 'terminal_split_source_not_found' {
  return replaced ? 'terminal_pane_owner_changed' : 'terminal_split_source_not_found'
}

/** Either refusal the commit rethrows as is, whatever the spawn; every other failure is a save failure. */
export function isRuntimePaneBindRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'terminal_pane_owner_changed' ||
      error.message === 'terminal_split_source_not_found')
  )
}
