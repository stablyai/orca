import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import { PANE_NOT_LIVE_ERROR } from '../../../../shared/pane-attach-only-view'
import {
  consumeHiddenRendererPtyDropMemory,
  hiddenRendererPtyDropEpisode,
  isRuntimeOwnedHiddenRendererPty,
  markRuntimeOwnedHiddenRendererPty
} from '../../pty-hidden-delivery-gate'
import { attachingRendererViewPtys } from '../delivery/visibility-state'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../providers/pty-provider-contract'

/**
 * Layout-owner build: a window view of a pane with no recorded owner attaches to the terminal it
 * names, or starts nothing; main starts a pane whose terminal is gone.
 */
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

/** The spawn's attach-only flag; a build without the switch keeps today's start. */
export function attachOnlyViewOf(args: { attachOnlyView?: unknown }): true | undefined {
  return ORCA_LAYOUT_OWNER_IS_MAIN && args.attachOnlyView === true ? true : undefined
}

/**
 * Layout-owner build: main starts the pane hidden, dropping its output until a view attaches. A
 * visible view keeps main's start from hiding it, and unmarks one already hidden before attaching,
 * so its attach snapshot holds every dropped byte and the view paints once.
 */
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
    // Why: until a view attaches, main must keep answering the pane's startup queries.
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
  // Why a snapshot of the same id: a local attach carries none, and another id's drops may postdate it.
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
