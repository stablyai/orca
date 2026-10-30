import { randomUUID } from 'node:crypto'
import { BrowserError } from '../../browser/browser-error'
import { browserNetworkExecutionHostKey } from '../../browser/browser-network-execution-route'
import type { RuntimeNavigationTarget } from '../../../shared/runtime-navigation'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../../shared/browser-client-automation-protocol'
import { BROWSER_HOST_WEBVIEW_CAPABILITY } from '../browser-host/browser-host-capability-selection'
import {
  publishCreatedBrowserSessionTab,
  resolveBrowserTabCreateFocus
} from '../browser-tab-create-publication'
import {
  createRuntimeBrowserClientPage,
  navigateRuntimeBrowserClientPage
} from '../runtime-browser-client-page-creation'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'

// Engine-free Node hosts also place pages on paired desktops.
export type BrowserClientPageOpeningHost = Pick<
  RuntimeBrowserCommandHost,
  | 'getAgentBrowserBridge'
  | 'resolveBrowserWorkspace'
  | 'resolveBrowserNetworkExecutionHost'
  | 'getBrowserHostLeaseRegistry'
  | 'getRuntimeBrowserPageRegistry'
  | 'markHeadlessBrowserSessionTabActive'
  | 'notifyHeadlessBrowserSessionTabsChanged'
>

type ResolvedWorkspace = Awaited<ReturnType<RuntimeBrowserCommandHost['resolveBrowserWorkspace']>>

export type BrowserClientPageCreateParams = {
  url?: string
  page?: string
  activate?: boolean
  navigation?: RuntimeNavigationTarget
  targetGroupId?: string
  placement: { kind: 'client'; browserHostClientId: string }
}

export type BrowserClientPageCaller = { pairedDeviceId?: string; clientKind?: 'mobile' | 'runtime' }

export const DEFAULT_BROWSER_PROFILE_ID = 'default'

export const BROWSER_HOST_UNAVAILABLE_MESSAGE =
  "No paired Orca desktop is hosting browser pages for this server. On a desktop paired with it, open a browser tab in one of this server's workspaces, then retry. The desktop needs an Orca version that hosts this server's pages."

export async function createBrowserClientPage(
  host: BrowserClientPageOpeningHost,
  params: BrowserClientPageCreateParams,
  context: {
    worktree: ResolvedWorkspace | undefined
    browserProfileId: string
    caller: BrowserClientPageCaller | undefined
  }
): Promise<{ browserPageId: string }> {
  const { worktree, browserProfileId, caller } = context
  if (!caller?.pairedDeviceId) {
    throw new BrowserError(
      'forbidden',
      'Client-hosted browser pages require an authenticated paired runtime.'
    )
  }
  if (!worktree) {
    throw new BrowserError(
      'invalid_argument',
      'Client-hosted browser pages require an explicit workspace.'
    )
  }
  const url = params.url ?? 'about:blank'
  const focus = resolveBrowserTabCreateFocus({
    activate: params.activate,
    navigation: params.navigation,
    clientKind: caller.clientKind
  })
  const browserPageId = params.page ?? randomUUID()
  const executionHost = await host.resolveBrowserNetworkExecutionHost(worktree)
  const authority = host.getBrowserHostLeaseRegistry()
  const created = await createRuntimeBrowserClientPage(authority, {
    browserPageId,
    browserHostClientId: params.placement.browserHostClientId,
    pairedDeviceId: caller.pairedDeviceId,
    browserProfileId,
    executionHost,
    workspaceId: worktree.id
  })
  const pages = host.getRuntimeBrowserPageRegistry()
  pages.publishClientPage({
    browserPageId,
    workspaceId: worktree.id,
    browserProfileId,
    executionHostKey: browserNetworkExecutionHostKey(executionHost),
    placement: created.placement,
    pairedDeviceId: caller.pairedDeviceId,
    url: 'about:blank',
    loading: url !== 'about:blank',
    active: focus.startsActive
  })
  publishCreatedBrowserSessionTab(host, {
    placementKind: 'client',
    browserPageId,
    worktreeId: worktree.id,
    focus,
    clientNavigationId: caller.pairedDeviceId,
    targetGroupId: params.targetGroupId
  })
  if (url !== 'about:blank') {
    try {
      await navigateRuntimeBrowserClientPage(authority, {
        browserPageId,
        placement: created.placement,
        url
      })
      pages.updatePage(browserPageId, created.placement, { url, loading: false })
    } catch {
      pages.updatePage(browserPageId, created.placement, { loading: false })
    }
    host.notifyHeadlessBrowserSessionTabsChanged?.(worktree.id)
  }
  return { browserPageId }
}

export function openBrowserUrlOnClient(
  host: BrowserClientPageOpeningHost,
  params: { url: string; worktree: string }
): Promise<{ browserPageId: string }> {
  assertClientOpenableUrl(params.url)
  return createBrowserPageOnPairedHost(
    host,
    { url: params.url, worktree: params.worktree, activate: true, navigation: 'caller' },
    DEFAULT_BROWSER_PROFILE_ID
  )
}

export function assertClientOpenableUrl(url: string): void {
  const protocol = new URL(url).protocol
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new BrowserError('invalid_argument', 'Only http(s) URLs can be opened on the client.')
  }
}

export async function createBrowserPageOnPairedHost(
  host: BrowserClientPageOpeningHost,
  params: Omit<BrowserClientPageCreateParams, 'placement'> & { worktree?: string },
  browserProfileId: string
): Promise<{ browserPageId: string }> {
  const lease = selectPairedPageHost(host)
  const { worktree, ...rest } = params
  return createBrowserClientPage(
    host,
    { ...rest, placement: { kind: 'client', browserHostClientId: lease.browserHostClientId } },
    {
      worktree: worktree ? await host.resolveBrowserWorkspace(worktree) : undefined,
      browserProfileId,
      caller: { pairedDeviceId: lease.pairedDeviceId, clientKind: 'runtime' }
    }
  )
}

/** Ambiguous selection still counts as an available paired host. */
export function hasPairedPageHost(
  host: Pick<BrowserClientPageOpeningHost, 'getBrowserHostLeaseRegistry'>
): boolean {
  try {
    selectPairedPageHost(host)
    return true
  } catch (error) {
    return error instanceof Error && error.message === 'browser_host_ambiguous'
  }
}

function selectPairedPageHost(
  host: Pick<BrowserClientPageOpeningHost, 'getBrowserHostLeaseRegistry'>
): { browserHostClientId: string; pairedDeviceId: string } {
  try {
    return host
      .getBrowserHostLeaseRegistry()
      .select(undefined, [
        BROWSER_HOST_WEBVIEW_CAPABILITY,
        BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY
      ])
  } catch (error) {
    // Other error codes already name their action.
    if (error instanceof Error && error.message === 'browser_host_unavailable') {
      throw new BrowserError('browser_host_unavailable', BROWSER_HOST_UNAVAILABLE_MESSAGE)
    }
    throw error
  }
}
