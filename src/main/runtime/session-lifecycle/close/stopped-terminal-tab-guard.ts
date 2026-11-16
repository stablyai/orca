import type { RuntimeMobileSessionSnapshotTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { PtyLivenessVerdict } from '../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import type { MobileSessionLifecycleCloseContext } from './mobile-session-lifecycle-close-adjudication'

export function assertStoppedTerminalTab(
  tab: RuntimeMobileSessionSnapshotTab | undefined,
  tabId: string,
  lifecycleClose: MobileSessionLifecycleCloseContext,
  getVerdict: (ptyId: string) => PtyLivenessVerdict | null,
  savedRemoteSessionId?: string
): void {
  if (tab?.type !== 'terminal' || tab.parentTabId !== tabId) {
    throw Object.assign(new Error('No terminal tab with this tab id exists in the workspace.'), {
      code: 'terminal_tab_not_found'
    })
  }
  const ptyIds = new Set([
    savedRemoteSessionId,
    ...lifecycleClose.parentLeaves.flatMap((leaf) => [
      leaf.ptyId,
      ...Object.values(leaf.parentLayout?.ptyIdsByLeafId ?? {})
    ]),
    ...lifecycleClose.rendererLeaves.map((leaf) => leaf.ptyId)
  ])
  if (
    lifecycleClose.parentLeaves.some(lifecycleClose.leafHasConnectedPty) ||
    lifecycleClose.rendererLeaves.some(lifecycleClose.rendererLeafHasConnectedPty) ||
    [...ptyIds].some((id) => id && getVerdict(id)?.status === 'live')
  ) {
    throw Object.assign(new Error('Terminal tab still has a live PTY.'), {
      code: 'terminal_tab_live',
      data: { nextStep: 'Use orca terminal close --terminal <handle> --tab.' }
    })
  }
  if ([...ptyIds].some((id) => id && getVerdict(id)?.status !== 'exited')) {
    throw Object.assign(new Error('Cannot confirm that every PTY in this tab has stopped.'), {
      code: 'terminal_stop_unverifiable'
    })
  }
}
