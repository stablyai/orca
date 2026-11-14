import { randomUUID } from 'node:crypto'
import { BrowserError } from '../../../browser/browser-error'
import { retireFailedBrowserClientPagePublication } from './browser-client-page-close'
import '../../../browser/network/execution-routes/browser-network-execution-route'
import { browserNetworkExecutionHostKey } from '../../../../shared/browser/client-hosting/browser-network-execution-host'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import {
  BROWSER_HOST_WEBVIEW_CAPABILITY,
  BrowserHostAmbiguousError
} from '../../browser-host/leases/browser-host-capability-selection'
import type { BrowserHostLease } from '../../browser-host/leases/browser-host-lease-records'
import { BrowserHostUnresponsiveError } from '../../browser-host/leases/browser-host-request-registry'
import {
  publishCreatedBrowserSessionTab,
  resolveBrowserTabCreateFocus
} from '../tabs/browser-tab-create-publication'
import {
  createRuntimeBrowserClientPage,
  navigateRuntimeBrowserClientPage
} from './runtime-browser-client-page-creation'
import type { RuntimeBrowserCommandHost } from '../commands/browser-command-contracts'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'

// Engine-free Node hosts also place pages on paired desktops.
export type BrowserClientPageOpeningHost = Pick<
  RuntimeBrowserCommandHost,
  | 'getAgentBrowserBridge'
  | 'resolveBrowserWorkspace'
  | 'resolveBrowserNetworkExecutionHost'
  | 'getBrowserHostLeaseRegistry'
  | 'getBrowserHostRequestRegistry'
  | 'getPairedDeviceName'
  | 'getRuntimeBrowserPageRegistry'
  | 'markHeadlessBrowserSessionTabActive'
  | 'notifyHeadlessBrowserSessionTabsChanged'
  | 'retireRuntimeOwnedBrowserSessionTab'
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

export type BrowserClientPageCaller = {
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
  signal?: AbortSignal
}

export const DEFAULT_BROWSER_PROFILE_ID = 'default'

export const BROWSER_HOST_UNAVAILABLE_MESSAGE =
  'No paired Orca desktop is hosting browser pages for this server. Keep an Orca desktop paired with this server connected, then retry. If it renders remote pages on the server, set Settings › Browser › Remote server workspaces to "This device". Older desktops host only after you open a browser tab in one of this server\'s workspaces.'

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
  const pages = host.getRuntimeBrowserPageRegistry()
  if (pages.getPage(browserPageId)) {
    throw new Error('browser_page_replacement_requires_retirement')
  }
  let publication: Promise<void> | undefined
  const created = await createRuntimeBrowserClientPage(authority, {
    browserPageId,
    browserHostClientId: params.placement.browserHostClientId,
    pairedDeviceId: caller.pairedDeviceId,
    browserProfileId,
    executionHost,
    workspaceId: worktree.id,
    signal: caller.signal,
    committed: (placement) => {
      try {
        pages.publishClientPage({
          browserPageId,
          workspaceId: worktree.id,
          browserProfileId,
          executionHostKey: browserNetworkExecutionHostKey(executionHost),
          placement: placement,
          pairedDeviceId: caller.pairedDeviceId,
          url: 'about:blank',
          loading: url !== 'about:blank',
          active: focus.startsActive
        })
        publication = publishCreatedBrowserSessionTab(host, {
          placementKind: 'client',
          browserPageId,
          worktreeId: worktree.id,
          focus,
          clientNavigationId: caller.pairedDeviceId,
          targetGroupId: params.targetGroupId
        })
      } catch (error) {
        if (pages.retirePage(browserPageId, placement)) {
          host.retireRuntimeOwnedBrowserSessionTab?.(worktree.id, browserPageId)
        }
        throw error
      }
    }
  })
  try {
    await publication
  } catch (error) {
    await retireFailedBrowserClientPagePublication(host, browserPageId, created.placement)
    throw error
  }
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
  params: { url: string; worktree: string },
  signal?: AbortSignal
): Promise<{ browserPageId: string }> {
  assertClientOpenableUrl(params.url)
  return createBrowserPageOnPairedHost(
    host,
    { url: params.url, worktree: params.worktree, activate: true, navigation: 'caller' },
    DEFAULT_BROWSER_PROFILE_ID,
    undefined,
    signal
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
  browserProfileId: string,
  /** The server's own browser, used when no paired desktop takes the page. */
  fallback?: () => Promise<{ browserPageId: string }>,
  signal?: AbortSignal
): Promise<{ browserPageId: string }> {
  const { worktree: selector, ...rest } = params
  const worktree = selector ? await host.resolveBrowserWorkspace(selector) : undefined
  let lease: BrowserHostLease
  try {
    // With a fallback, ask a desktop even while it hosts: its own setting decides, and a sleeping one times out.
    lease = await acquirePairedPageHost(host, worktree?.id, fallback !== undefined)
  } catch (error) {
    if (fallback && error instanceof BrowserError && error.code === 'browser_host_unavailable') {
      return fallback()
    }
    throw error
  }
  return createBrowserClientPage(
    host,
    { ...rest, placement: { kind: 'client', browserHostClientId: lease.browserHostClientId } },
    {
      worktree,
      browserProfileId,
      caller: { pairedDeviceId: lease.pairedDeviceId, clientKind: 'runtime', signal }
    }
  )
}

/** Ambiguous selection still counts as an available paired host. */
export function hasPairedPageHost(
  host: Pick<BrowserClientPageOpeningHost, 'getBrowserHostLeaseRegistry'>
): boolean {
  try {
    selectPairedPageHost(host.getBrowserHostLeaseRegistry())
    return true
  } catch (error) {
    return isHostError(error, 'browser_host_ambiguous')
  }
}

/** A desktop that could host on request counts too, though it holds no lease yet. */
export function canPlacePairedPage(
  host: Pick<
    BrowserClientPageOpeningHost,
    'getBrowserHostLeaseRegistry' | 'getBrowserHostRequestRegistry'
  >
): boolean {
  return hasPairedPageHost(host) || host.getBrowserHostRequestRegistry().hasVolunteer()
}

type PairedPageHostSource = Pick<
  BrowserClientPageOpeningHost,
  | 'getBrowserHostLeaseRegistry'
  | 'getBrowserHostRequestRegistry'
  | 'getPairedDeviceName'
  | 'getRuntimeBrowserPageRegistry'
>

/** No caller names a host for these pages, so the server picks one desktop and never leaves it ambiguous. */
async function acquirePairedPageHost(
  host: PairedPageHostSource,
  workspaceId: string | undefined,
  askDesktop: boolean
): Promise<BrowserHostLease> {
  const leases = host.getBrowserHostLeaseRegistry()
  // Only desktops that answer asks are asked; older ones keep the server's own browser.
  if (!askDesktop) {
    try {
      return selectPairedPageHost(leases)
    } catch (error) {
      // Several desktops already host: choose one of them rather than asking for another lease.
      if (error instanceof BrowserHostAmbiguousError) {
        return chooseAmongHosts(host, error.browserHostClientIds, workspaceId)
      }
      if (!isHostError(error, 'browser_host_unavailable')) {
        throw error
      }
    }
  }
  try {
    const requested = await host.getBrowserHostRequestRegistry().request()
    // Name the lease so another desktop attaching meanwhile cannot make selection ambiguous.
    const lease = selectPairedPageHost(leases, requested.browserHostClientId)
    if (lease.pairedDeviceId !== requested.pairedDeviceId) {
      throw new Error('browser_host_unavailable')
    }
    return lease
  } catch (error) {
    if (error instanceof BrowserHostUnresponsiveError) {
      const name = host.getPairedDeviceName?.(error.pairedDeviceId)
      throw new BrowserError('browser_host_unavailable', unresponsiveHostMessage(name))
    }
    // Other error codes already name their action.
    if (isHostError(error, 'browser_host_unavailable')) {
      throw new BrowserError('browser_host_unavailable', BROWSER_HOST_UNAVAILABLE_MESSAGE)
    }
    throw error
  }
}

// The desktop already showing this workspace's pages is where the user looks; the newest lease breaks ties.
function chooseAmongHosts(
  host: PairedPageHostSource,
  browserHostClientIds: readonly string[],
  workspaceId: string | undefined
): BrowserHostLease {
  const leases = host.getBrowserHostLeaseRegistry()
  const showingWorkspace = new Set(
    host
      .getRuntimeBrowserPageRegistry()
      .listPages()
      .filter((page) => page.workspaceId === workspaceId)
      .map((page) => page.placement.browserHostClientId)
  )
  const [chosen] = browserHostClientIds
    .map((browserHostClientId) => selectPairedPageHost(leases, browserHostClientId))
    .toSorted(
      (a, b) =>
        Number(showingWorkspace.has(b.browserHostClientId)) -
          Number(showingWorkspace.has(a.browserHostClientId)) ||
        b.browserHostGeneration - a.browserHostGeneration
    )
  if (!chosen) {
    throw new Error('browser_host_unavailable')
  }
  return chosen
}

function unresponsiveHostMessage(deviceName: string | null | undefined): string {
  const desktop = deviceName ? `The Orca desktop "${deviceName}"` : 'The paired Orca desktop'
  return `${desktop} didn't respond when this server asked it to host browser pages; it may be asleep or disconnected. Wake it and retry, or open a browser tab in one of this server's workspaces on the desktop you want to use.`
}

function selectPairedPageHost(
  leases: BrowserHostLeaseRegistry,
  browserHostClientId?: string
): BrowserHostLease {
  return leases.select(browserHostClientId, [
    BROWSER_HOST_WEBVIEW_CAPABILITY,
    BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY
  ])
}

function isHostError(error: unknown, code: string): boolean {
  return error instanceof Error && error.message === code
}
