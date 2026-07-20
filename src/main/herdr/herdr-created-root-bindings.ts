import type { TerminalTab } from '../../shared/types'
import { herdrPaneRef, herdrTabRef } from '../../shared/herdr-session-identity'
import type { HerdrHostTransport, HerdrPane, HerdrTab } from './herdr-runtime-contract'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import { externalRefKey, type HerdrReconcileIndex } from './herdr-reconcile-index'

export async function bindCreatedHerdrRoots(
  transport: HerdrHostTransport,
  sessionName: string,
  projectId: string,
  firstTab: TerminalTab | undefined,
  firstLeafId: string | null,
  created: { tab: HerdrTab; root_pane: HerdrPane },
  index: HerdrReconcileIndex
): Promise<void> {
  if (firstTab) {
    const ref = herdrTabRef(projectId, firstTab.id)
    const tab = unwrapHerdrResponse<{ tab: HerdrTab }>(
      await transport.request(sessionName, 'tab.bind', {
        tab_id: created.tab.tab_id,
        external_ref: ref
      })
    ).tab
    index.tabs.set(externalRefKey(ref), tab)
  } else if (created.tab.external_ref) {
    index.tabs.set(externalRefKey(created.tab.external_ref), created.tab)
  }

  if (firstLeafId) {
    const ref = herdrPaneRef(projectId, firstLeafId)
    const pane = unwrapHerdrResponse<{ pane: HerdrPane }>(
      await transport.request(sessionName, 'pane.bind', {
        pane_id: created.root_pane.pane_id,
        external_ref: ref
      })
    ).pane
    index.panes.set(externalRefKey(ref), pane)
  } else if (created.root_pane.external_ref) {
    index.panes.set(externalRefKey(created.root_pane.external_ref), created.root_pane)
  }
}
