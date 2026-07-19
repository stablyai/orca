import { herdrExternalRefKey, type HerdrExternalRef } from '../../shared/herdr-session-identity'
import type {
  HerdrPane,
  HerdrSessionSnapshot,
  HerdrTab,
  HerdrWorkspace
} from './herdr-runtime-contract'

export type HerdrReconcileIndex = {
  workspaces: Map<string, HerdrWorkspace>
  tabs: Map<string, HerdrTab>
  panes: Map<string, HerdrPane>
  unclaimedWorkspaces: HerdrWorkspace[]
  unclaimedTabs: HerdrTab[]
  unclaimedPanes: HerdrPane[]
}

export function indexHerdrSnapshot(snapshot: HerdrSessionSnapshot): HerdrReconcileIndex {
  return {
    workspaces: new Map(
      snapshot.workspaces.flatMap((workspace) =>
        workspace.external_ref
          ? [[herdrExternalRefKey(workspace.external_ref), workspace] as const]
          : []
      )
    ),
    tabs: new Map(
      snapshot.tabs.flatMap((tab) =>
        tab.external_ref ? [[herdrExternalRefKey(tab.external_ref), tab] as const] : []
      )
    ),
    panes: new Map(
      snapshot.panes.flatMap((pane) =>
        pane.external_ref ? [[herdrExternalRefKey(pane.external_ref), pane] as const] : []
      )
    ),
    unclaimedWorkspaces: snapshot.workspaces.filter((workspace) => !workspace.external_ref),
    unclaimedTabs: snapshot.tabs.filter((tab) => !tab.external_ref),
    unclaimedPanes: snapshot.panes.filter((pane) => !pane.external_ref)
  }
}

export function takeUniqueMatch<T>(items: T[], matches: (item: T) => boolean): T | null {
  const indexes = items.flatMap((item, index) => (matches(item) ? [index] : []))
  if (indexes.length !== 1) {
    return null
  }
  return items.splice(indexes[0], 1)[0] ?? null
}

export function externalRefKey(ref: HerdrExternalRef): string {
  return herdrExternalRefKey(ref)
}
