import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence'
import { ptyBindingIsRefused } from '../../../persistence/loading-store/pty-binding-refusals'
import type { PtySpawnOutcome } from '../spawn-outcome'
import type { PaneSpawnReservation } from './spawn-reservation'

export class PaneOwnerContentionError extends Error {
  constructor() {
    super('terminal_pane_owner_changed')
  }
}

/** A binding the operation's host answer proved dead, with every incarnation it was known by. */
export type AbsentPaneBinding = { ptyId: string; incarnationIds: readonly string[] }

/** In-process authority of the enclosing operation; never sent over IPC/RPC or saved. */
export type PaneSpawnOperation = {
  mustExist: boolean
  absentOwner?: AbsentPaneBinding
  acquisition?: {
    key: string
    reservation: PaneSpawnReservation
    surfaceWithdrawn?: true
    settle: (outcome: PtySpawnOutcome) => void
  }
}

// Why: a window save can replay the binding the operation just proved dead; that is not an owner.
export function isAbsentBindingReplay(
  absent: AbsentPaneBinding | undefined,
  ptyId: string,
  incarnationId: string | undefined
): boolean {
  return (
    absent?.ptyId === ptyId &&
    (incarnationId === undefined || absent.incarnationIds.includes(incarnationId))
  )
}

/** Null when the resolved owner is only that replay. */
export function excludeAbsentOwnerReplay<
  T extends { ptyId: string; persistedIncarnationId?: string; runtimeIncarnationId?: string }
>(owner: T | null, absent: AbsentPaneBinding | undefined): T | null {
  return owner &&
    isAbsentBindingReplay(absent, owner.ptyId, owner.persistedIncarnationId) &&
    isAbsentBindingReplay(absent, owner.ptyId, owner.runtimeIncarnationId)
    ? null
    : owner
}

export function assertPaneStillExists(
  store: Store | undefined,
  worktreeId: string,
  tabId: string,
  leafId: string,
  connectionId?: string | null
): void {
  if (!store) {
    throw new Error('terminal_pane_owner_changed')
  }
  const session = store.getWorkspaceSession(
    connectionId ? toSshExecutionHostId(connectionId) : undefined
  )
  if (
    ptyBindingIsRefused(
      { tabId, leafId, mayCreate: false },
      session,
      worktreeId,
      makePaneKey(tabId, leafId),
      []
    )
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
}
