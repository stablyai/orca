import type { HerdrExternalRef } from '../../shared/herdr-session-identity'
import type { HerdrHostTransport, HerdrPane, HerdrTab } from './herdr-runtime-contract'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import { externalRefKey, type HerdrReconcileIndex, takeUniqueMatch } from './herdr-reconcile-index'

export async function ensureExistingHerdrTabRoot(
  transport: HerdrHostTransport,
  sessionName: string,
  tab: HerdrTab,
  rootExternalRef: HerdrExternalRef,
  index: HerdrReconcileIndex
): Promise<HerdrPane | undefined> {
  const adoptablePane = takeUniqueMatch(
    index.unclaimedPanes,
    (candidate) => candidate.tab_id === tab.tab_id
  )
  if (adoptablePane) {
    const pane = unwrapHerdrResponse<{ pane: HerdrPane }>(
      await transport.request(sessionName, 'pane.bind', {
        pane_id: adoptablePane.pane_id,
        external_ref: rootExternalRef
      })
    ).pane
    index.panes.set(externalRefKey(rootExternalRef), pane)
    return pane
  }

  const existingPane = [...index.panes.values()].find(
    (candidate) => candidate.tab_id === tab.tab_id
  )
  if (!existingPane) {
    return undefined
  }
  const pane = unwrapHerdrResponse<{ pane: HerdrPane }>(
    await transport.request(sessionName, 'pane.split', {
      target_pane_id: existingPane.pane_id,
      direction: 'right',
      ratio: 0.5,
      focus: false,
      external_ref: rootExternalRef
    })
  ).pane
  index.panes.set(externalRefKey(rootExternalRef), pane)
  return pane
}
