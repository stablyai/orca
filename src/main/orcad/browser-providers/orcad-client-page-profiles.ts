import { BrowserError } from '../../browser/browser-error'
import type { RuntimeBrowserCommandHost } from '../../runtime/browser/commands/browser-command-contracts'
import { DEFAULT_BROWSER_PROFILE_ID } from '../../runtime/browser/client-pages/browser-client-page-opening'
import type { RuntimeBrowserClientPage } from '../../runtime/browser/client-pages/runtime-browser-page-registry'

// Same target as the Electron runtime: an explicit page, else the worktree's active page.
export async function resolveTargetClientPage(
  host: RuntimeBrowserCommandHost,
  params: { page?: string; worktree?: string }
): Promise<RuntimeBrowserClientPage | undefined> {
  const pages = host.getRuntimeBrowserPageRegistry()
  const workspaceId = params.worktree
    ? (await host.resolveBrowserWorkspace(params.worktree)).id
    : undefined
  const page = params.page
    ? pages.getPage(params.page)
    : workspaceId !== undefined
      ? pages.listPages(workspaceId).find((candidate) => candidate.active)
      : undefined
  if (page && workspaceId !== undefined && page.workspaceId !== workspaceId) {
    throw new BrowserError(
      'browser_tab_not_found',
      `Browser page ${page.browserPageId} was not found in this worktree`
    )
  }
  return page
}

// orcad lacks a registry to describe non-default profiles to the desktop.
export function orcadBrowserProfileId(profileId: string | undefined): string {
  if (profileId !== undefined && profileId !== DEFAULT_BROWSER_PROFILE_ID) {
    throw new BrowserError(
      'invalid_argument',
      `Browser profile ${profileId} was not found. Pages this server shows on your desktop use the Default profile.`
    )
  }
  return DEFAULT_BROWSER_PROFILE_ID
}

export function orcadProfileLabel(browserProfileId: string): { id: string; label: string } {
  return {
    id: browserProfileId,
    label: browserProfileId === DEFAULT_BROWSER_PROFILE_ID ? 'Default' : browserProfileId
  }
}
