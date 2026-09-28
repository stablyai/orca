import type { Store } from '../../../persistence'
import type { PtySpawnResult } from '../../../providers/types'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { spawnCommitBindingOrigin } from '../../../persistence/loading-store/pty-binding-span'
import type { StablePaneOwner } from './stable-owner'

export function stablePanePersistenceFence(
  owner: StablePaneOwner | null
): { ptyId: string; incarnationId?: string } | undefined {
  return owner?.hasPersistedBinding
    ? {
        ptyId: owner.ptyId,
        ...(owner.persistedIncarnationId ? { incarnationId: owner.persistedIncarnationId } : {})
      }
    : undefined
}

export async function persistAdmittedStablePaneBinding(args: {
  store: Store | undefined
  owner: StablePaneOwner | null
  result: PtySpawnResult
  worktreeId: string | undefined
  startupCwd: string | undefined
  connectionId: string | null | undefined
}): Promise<boolean> {
  const expectedBinding = stablePanePersistenceFence(args.owner)
  if (!args.store || !args.owner || !args.worktreeId || !expectedBinding) {
    return false
  }
  const persisted = await args.store.persistPtyBinding(
    {
      worktreeId: args.worktreeId,
      tabId: args.owner.tabId,
      leafId: args.owner.leafId,
      ptyId: args.result.id,
      ...(args.result.incarnationId ? { incarnationId: args.result.incarnationId } : {}),
      ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
      expectedBinding,
      origin: spawnCommitBindingOrigin(args.result)
    },
    args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
  )
  if (persisted === false) {
    throw new Error('terminal_pane_owner_changed')
  }
  return true
}
