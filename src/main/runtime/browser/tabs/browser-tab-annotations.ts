import type { BrowserPageAnnotation } from '../../../../shared/browser/element-grab/browser-grab-types'
import type {
  BrowserTabAnnotationsResult,
  BrowserTabInfo
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { isHostReachableDocument } from '../../../../shared/desktop-browser-bridge-protocol'
import { BrowserError } from '../../../browser/browser-error'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimeBrowserCommandHost } from '../commands/browser-command-contracts'
import { remoteCliBrowserScopeWorkspaceId } from '../../desktop-browser-bridge/remote-cli-browser-scope'

/** A page's unsent notes from the saved session, which the window keeps current. */
export function readSavedBrowserPageAnnotations(
  store:
    | Pick<RuntimeStore, 'getWorkspaceSession' | 'getWorkspaceSessionHostIds'>
    | null
    | undefined,
  browserPageId: string
): BrowserPageAnnotation[] {
  // Page ids are unique across hosts, and a bridged SSH page has no worktree row here.
  for (const hostId of store?.getWorkspaceSessionHostIds?.() ?? []) {
    const pages = store?.getWorkspaceSession?.(hostId)?.browserPagesByWorkspace ?? {}
    for (const workspacePages of Object.values(pages)) {
      const page = workspacePages.find((candidate) => candidate.id === browserPageId)
      if (page) {
        return page.annotations ?? []
      }
    }
  }
  return []
}

export function findListedBrowserTab(
  tabs: readonly BrowserTabInfo[],
  page: string
): BrowserTabInfo {
  const tab = tabs.find((candidate) => candidate.browserPageId === page)
  if (!tab) {
    throw new BrowserError('browser_tab_not_found', `Browser page ${page} was not found`)
  }
  return tab
}

export function readBrowserTabAnnotations(
  host: Pick<
    RuntimeBrowserCommandHost,
    'getRuntimeBrowserPageRegistry' | 'readBrowserPageAnnotations'
  >,
  tab: BrowserTabInfo
): BrowserTabAnnotationsResult {
  // A paired desktop draws this page and keeps its notes; this host would wrongly report none.
  if (host.getRuntimeBrowserPageRegistry().getPage(tab.browserPageId)) {
    throw new BrowserError(
      'browser_annotations_unavailable',
      `Tab ${tab.browserPageId} is drawn by a paired desktop, which keeps its unsent notes. Ask the user to send them from that tab.`
    )
  }
  const annotations = host.readBrowserPageAnnotations?.(tab.browserPageId) ?? []
  return {
    tab,
    // An SSH host may not read what a note captured from a desktop-local document.
    annotations:
      remoteCliBrowserScopeWorkspaceId() === undefined
        ? annotations
        : annotations.filter((note) => isHostReachableDocument(note.payload.page.sanitizedUrl))
  }
}
