import type { BrowserTabProfileCloneResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { BrowserError } from '../../../browser/browser-error'
import { browserSessionRegistry } from '../../../browser/sessions/profiles/browser-session-registry'
import type { BrowserClientPageOpeningHost } from '../client-pages/browser-client-page-opening'
import { cloneBrowserClientPage } from '../client-pages/browser-client-page-clone'
import type { RuntimeBrowserTabCatalog } from '../tabs/browser-tab-catalog'
import type { RuntimeBrowserTabCreation } from '../tabs/browser-tab-creation'
import { createBrowserTabInRenderer } from '../tabs/browser-tab-renderer-create'
import { waitForTabRegistration } from '../../../ipc/browser/browser-tab-registration-wait'
import type {
  BrowserCommandTargetParams,
  RuntimeBrowserCommandHost
} from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'

export type BrowserTabProfileCloneDependencies = {
  host: BrowserClientPageOpeningHost &
    Pick<RuntimeBrowserCommandHost, 'getAvailableAuthoritativeWindow' | 'getAuthoritativeWindow'>
  targets: Pick<
    RuntimeBrowserCommandTargets,
    'requireAgentBrowserBridge' | 'resolveBrowserCommandTarget'
  >
  catalog: Pick<RuntimeBrowserTabCatalog, 'describeBrowserTab' | 'resolveClientHostedBrowserPage'>
  creation: Pick<RuntimeBrowserTabCreation, 'browserTabCreate'>
}

/** Opens a tab's URL again in another profile, in the same browser that holds the tab. */
export async function cloneBrowserTabToProfile(
  dependencies: BrowserTabProfileCloneDependencies,
  params: { profileId: string } & BrowserCommandTargetParams
): Promise<BrowserTabProfileCloneResult> {
  const profile = browserSessionRegistry.getProfile(params.profileId)
  if (!profile) {
    throw new BrowserError('invalid_argument', `Browser profile ${params.profileId} was not found`)
  }
  const clientPage = await dependencies.catalog.resolveClientHostedBrowserPage(params)
  const cloned = clientPage
    ? {
        sourceBrowserPageId: clientPage.browserPageId,
        ...(await cloneBrowserClientPage(dependencies.host, clientPage, profile.id))
      }
    : await createBesideEnginePage(dependencies, params, profile)
  return { ...cloned, profileId: profile.id, profileLabel: profile.label }
}

async function createBesideEnginePage(
  { host, targets, catalog, creation }: BrowserTabProfileCloneDependencies,
  params: BrowserCommandTargetParams,
  profile: { id: string; partition: string }
): Promise<{ browserPageId: string; sourceBrowserPageId: string }> {
  const target = await targets.resolveBrowserCommandTarget(params)
  const sourceBrowserPageId =
    target.browserPageId ?? targets.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
  if (!sourceBrowserPageId) {
    throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
  }
  const sourceTab = catalog.describeBrowserTab(sourceBrowserPageId, target.worktreeId)
  const worktreeId = sourceTab.worktreeId ?? target.worktreeId
  if (!host.getAvailableAuthoritativeWindow()) {
    // A headless host has no renderer; `tab create` opens the clone in its offscreen browser.
    const created = await creation.browserTabCreate({
      url: sourceTab.url,
      ...(worktreeId ? { worktree: `id:${worktreeId}` } : {}),
      profileId: profile.id,
      activate: false,
      placement: { kind: 'server' }
    })
    return { browserPageId: created.browserPageId, sourceBrowserPageId }
  }
  const created = await createBrowserTabInRenderer(
    host,
    sourceTab.url,
    worktreeId,
    profile.id,
    profile.partition
  )
  // Do not return an inoperable clone before its webview registers.
  try {
    await waitForTabRegistration(created.browserPageId)
  } catch {}
  return { browserPageId: created.browserPageId, sourceBrowserPageId }
}
