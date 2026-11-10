import { legacyPaneIdentitySelection } from './legacy-pane-identity-selection'
import { admitLegacyTerminalRestore } from '../../../pty/legacy-terminal-restore-ownership'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { PaneSpawnOperation } from './pane-spawn-operation'
import type { AdoptStablePaneArgs } from '../ipc/spawn-types'
export const legacyAcquisition = Symbol('legacyPaneAcquisition')
export type AcquisitionContext = NonNullable<PaneSpawnOperation['legacyRestore']>
export type AcquisitionArgs = AdoptStablePaneArgs & {
  [legacyAcquisition]?: AcquisitionContext | false
}
export function carryLegacyPaneAcquisition(
  args: AdoptStablePaneArgs,
  context: AcquisitionContext | false
): AdoptStablePaneArgs {
  return Object.assign(args, { [legacyAcquisition]: context })
}

export function createLegacyPaneAcquisition(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  args: AcquisitionArgs
) {
  if (
    args.connectionId ||
    args.stoppedPtyId ||
    args.attachOnlyView ||
    !store?.legacyTerminalIdentityAuthority ||
    !args.worktreeId
  ) {
    return
  }
  const session = store.getWorkspaceSession()
  const row = session.tabsByWorktree?.[args.worktreeId]?.find((row) => row.id === args.tabId)
  const layout = session.terminalLayoutsByTabId?.[args.tabId]
  const id =
    layout?.ptyIdsByLeafId?.[args.leafId] ??
    (layout?.root?.type === 'leaf' ? row?.ptyId : undefined)
  if (!id || !/^\d+$/.test(id)) {
    return
  }
  const admission = admitLegacyTerminalRestore(
    store.legacyTerminalIdentityAuthority,
    args.worktreeId,
    args.tabId,
    args.leafId,
    runtime?.markPtyLivenessUnverifiable?.bind(runtime)
  )
  return {
    release: admission.release,
    context: {
      attempt: admission.attempt,
      selection: legacyPaneIdentitySelection(
        { deps: { store }, args },
        makePaneKey(args.tabId, args.leafId),
        admission.attempt
      )
    }
  }
}
