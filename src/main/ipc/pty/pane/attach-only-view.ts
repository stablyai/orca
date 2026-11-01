import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import { PANE_NOT_LIVE_ERROR } from '../../../../shared/pane-attach-only-view'
import {
  consumeHiddenRendererPtyDropMemory,
  hiddenRendererPtyDropEpisode,
  isRuntimeOwnedHiddenRendererPty,
  markRuntimeOwnedHiddenRendererPty
} from '../delivery/pty-hidden-delivery-gate'
import { attachingRendererViewPtys } from '../delivery/visibility-state'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../providers/pty-provider-contract'

/** A view with no recorded owner may attach only to its named terminal; main owns fresh starts. */
export async function attachViewWithoutOwner(
  provider: IPtyProvider,
  spawnOptions: PtySpawnOptions
): Promise<PtySpawnResult> {
  if (!spawnOptions.sessionId) {
    throw new Error(PANE_NOT_LIVE_ERROR)
  }
  try {
    return await provider.spawn({
      cols: spawnOptions.cols,
      rows: spawnOptions.rows,
      sessionId: spawnOptions.sessionId,
      attachOnly: true
    })
  } catch (error) {
    throw error instanceof SessionNotFoundError ? new Error(PANE_NOT_LIVE_ERROR) : error
  }
}

export function attachOnlyViewOf(args: { attachOnlyView?: unknown }): true | undefined {
  return ORCA_LAYOUT_OWNER_IS_MAIN && args.attachOnlyView === true ? true : undefined
}

/** Visible attaches keep main-started PTYs unhidden before snapshot capture, covering dropped bytes in one paint. */
export async function attachViewAfterHiddenStart<T extends object>(
  ptyId: string,
  setHidden: (id: string, hidden: boolean) => void,
  attach: () => Promise<T>
): Promise<T> {
  const hiddenByMain = isRuntimeOwnedHiddenRendererPty(ptyId)
  const episode = hiddenRendererPtyDropEpisode(ptyId)
  if (hiddenByMain) {
    setHidden(ptyId, false)
  }
  const attaching = attachingRendererViewPtys.get(ptyId) ?? { views: 0, skippedHide: false }
  attaching.views += 1
  attachingRendererViewPtys.set(ptyId, attaching)
  let attached: T
  try {
    attached = await attach()
  } catch (error) {
    // Until a view attaches, main must continue answering startup queries.
    const keptVisibleByThisAttach = hiddenByMain || attaching.skippedHide
    if (
      keptVisibleByThisAttach &&
      !(error instanceof Error && error.message === PANE_NOT_LIVE_ERROR)
    ) {
      setHidden(ptyId, true)
      markRuntimeOwnedHiddenRendererPty(ptyId)
    }
    throw error
  } finally {
    attaching.views -= 1
    if (attaching.views === 0 && attachingRendererViewPtys.get(ptyId) === attaching) {
      attachingRendererViewPtys.delete(ptyId)
    }
  }
  // Retire drops only with a same-PTY snapshot; other IDs may have newer gaps.
  if (
    hiddenByMain &&
    'id' in attached &&
    attached.id === ptyId &&
    'snapshot' in attached &&
    typeof attached.snapshot === 'string'
  ) {
    // Retires only the episode the snapshot covers; a drop after a re-mark opened a new one.
    consumeHiddenRendererPtyDropMemory(ptyId, episode)
  }
  return attached
}
