import { BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY } from '../../shared/browser-client-profile-switch-protocol'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../shared/browser-client-automation-protocol'
import { BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY } from '../../shared/browser-client-file-channel-protocol'
import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { BrowserClientNetworkRouteRegistry } from './browser-client-network-route-registry'
import {
  browserAuthorityExecutionHostStorageIdentity,
  legacyBrowserNativeExecutionHostStorageIdentity
} from './browser-execution-host-storage-identity'
import { getBrowserClientHostId } from './browser-client-host-id'
import { deriveBrowserRoutePartitionStorageScope } from './browser-route-identity'
import { BrowserClientDownloadRelay } from './browser-client-download-relay'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import { registerBrowserClientHostEnvironmentRoutes } from './browser-client-host-environment-routes'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import { createBrowserClientPageGuestBinding } from './browser-client-page-guest-binding'
import { browserManager } from './browser-manager'
import { browserSessionRegistry } from './browser-session-registry'
import { BrowserClientUploadStaging } from './browser-client-upload-staging'
import {
  executeBrowserClientPageAutomation,
  retireBrowserClientPageAutomation
} from './browser-client-page-automation-runtime'
import { selectBrowserClientPageRenderer } from './browser-client-page-renderer-runtime'
import { PairedRuntimeBrowserClientHostComposition } from './paired-runtime-browser-client-host-composition'
import { PairedRuntimeBrowserClientHost } from './paired-runtime-browser-client-host'
import {
  PairedRuntimeBrowserClientHostRegistry,
  type PairedRuntimeBrowserClientHostStart
} from './paired-runtime-browser-client-host-registry'
import { PairedRuntimeBrowserNetworkRoute } from './paired-runtime-browser-network-route'
import { derivePairedRuntimeBrowserAuthorityIdentity } from './paired-runtime-browser-authority-identity'
import type { BrowserClientPageAuthorityIdentity } from './browser-client-page-command-executor-dependencies'
import {
  browserRouteSessionRegistry,
  browserRouteWebContentsRegistry
} from './browser-route-session-runtime'

export type ClientHostRouteIdentity = BrowserClientPageAuthorityIdentity & {
  orcaProfileId: string
  /** Pairs with `authorityConnectionIdentity` and `pairingAuthorityConnectionIdentity`. */
  executionHostIdentity: string
  /** Pairs with `legacyAuthorityConnectionIdentity`, naming the partition an older build populated. */
  legacyExecutionHostIdentity: string
  storageScope: string
}

type ProductionBrowserClientHostStart = PairedRuntimeBrowserClientHostStart &
  BrowserClientPageAuthorityIdentity & {
    connection: PairedRuntimeConnection
    orcaProfileId: string
    storageScope: string
    environmentLabel: string
  }

let activeOrcaProfileId: string | null = null
// Storage operations need a route identity even without an open page.
const clientHostRouteIdentities = new Map<string, ClientHostRouteIdentity>()

const browserClientHosts =
  new PairedRuntimeBrowserClientHostRegistry<ProductionBrowserClientHostStart>({
    createComposition: (input) => {
      // Authority replacement rebinds this composition-owned transport to the new lease.
      const fileChannel = new BrowserClientFileChannelTransport()
      const stagingRoot = browserClientFileStagingRoot(input.environmentId)
      const uploadStaging = new BrowserClientUploadStaging(path.join(stagingRoot, 'uploads'))
      let executor: BrowserClientPageCommandExecutor | null = null
      const downloadRelay = new BrowserClientDownloadRelay({
        stagingRoot: path.join(stagingRoot, 'downloads'),
        hostLabel: input.environmentLabel,
        transport: fileChannel,
        resolvePage: (webContentsId) => executor?.findPageByWebContentsId(webContentsId)
      })
      const routes = registerBrowserClientHostEnvironmentRoutes(
        input.environmentId,
        downloadRelay,
        (params) => executor?.recordPublishedPageUrl(params)
      )
      return new PairedRuntimeBrowserClientHostComposition({
        onClosing: routes.release,
        initialInput: input,
        createRoutes: (next, authority) =>
          createNetworkRoutes(next.connection, authority, next.storageScope, input.environmentId),
        createExecutor: (next, { retainNetworkRoute, onPageUnavailable }) => {
          executor = new BrowserClientPageCommandExecutor({
            orcaProfileId: next.orcaProfileId,
            authorityConnectionIdentity: next.authorityConnectionIdentity,
            pairingAuthorityConnectionIdentity: next.pairingAuthorityConnectionIdentity,
            legacyAuthorityConnectionIdentity: next.legacyAuthorityConnectionIdentity,
            storageScope: next.storageScope,
            retainNetworkRoute,
            selectRenderer: selectBrowserClientPageRenderer,
            routeSessions: browserRouteSessionRegistry,
            routeWebContents: browserRouteWebContentsRegistry,
            guestBinding: createBrowserClientPageGuestBinding(browserManager),
            executeAutomation: executeBrowserClientPageAutomation,
            retireAutomation: retireBrowserClientPageAutomation,
            fileChannel,
            uploadStaging,
            onPageUnavailable
          })
          return executor
        },
        createHost: (
          next,
          { handler, getPageInventory, onAuthority, onTransportLost, onReconnected, onError }
        ) => {
          const host = new PairedRuntimeBrowserClientHost({
            connection: next.connection,
            authorityRuntimeId: next.authorityRuntimeId,
            browserHostClientId: getBrowserClientHostId(),
            hostCapabilities: [
              'webview',
              BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY,
              BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY,
              BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY
            ],
            handler,
            getPageInventory,
            pageReconciliationProtocolVersion: 1,
            fileChannelProtocolVersion: 1,
            onAuthority,
            onTransportLost,
            onReconnected,
            onError
          })
          fileChannel.bind(host)
          routes.pageMetadata.bind(host)
          return host
        },
        onError: (error) => retireFailedEnvironmentHost(input.environmentId, error)
      })
    }
  })

export function configurePairedRuntimeBrowserClientHostsForOrcaProfile(options: {
  orcaProfileId: string
}): void {
  if (activeOrcaProfileId && activeOrcaProfileId !== options.orcaProfileId) {
    throw new Error('paired_runtime_browser_client_host_profile_conflict')
  }
  activeOrcaProfileId = options.orcaProfileId
}

export async function startPairedRuntimeBrowserClientHost(options: {
  environment: KnownRuntimeEnvironment
  authorityRuntimeId: string
}): Promise<BrowserClientHostLeaseAuthority> {
  const orcaProfileId = activeOrcaProfileId
  if (!orcaProfileId) {
    throw new Error('paired_runtime_browser_client_host_profile_unavailable')
  }
  const pairingRevision = options.environment.pairingRevision ?? options.environment.createdAt
  const connection = getPreferredPairedRuntimeConnection(options.environment)
  const storageScope = deriveBrowserRoutePartitionStorageScope({
    orcaProfileId,
    environmentId: options.environment.id
  })
  const authorityIdentity = derivePairedRuntimeBrowserAuthorityIdentity({
    orcaProfileId,
    environment: options.environment,
    pairingRevision,
    authorityRuntimeId: options.authorityRuntimeId,
    connection
  })
  const routeIdentity: ClientHostRouteIdentity = {
    orcaProfileId,
    storageScope,
    ...authorityIdentity,
    // Settings-level cookie imports target the server itself.
    executionHostIdentity: browserAuthorityExecutionHostStorageIdentity(storageScope),
    legacyExecutionHostIdentity: legacyBrowserNativeExecutionHostStorageIdentity(
      options.authorityRuntimeId
    )
  }
  const authority = await browserClientHosts.start({
    environmentId: options.environment.id,
    pairingRevision,
    authorityRuntimeId: options.authorityRuntimeId,
    connection,
    orcaProfileId,
    storageScope: routeIdentity.storageScope,
    environmentLabel: options.environment.name,
    ...authorityIdentity
  })
  const previous = clientHostRouteIdentities.get(options.environment.id)
  clientHostRouteIdentities.set(options.environment.id, routeIdentity)
  if (JSON.stringify(previous) !== JSON.stringify(routeIdentity)) {
    notifyRouteProfilesChanged()
  }
  return authority
}

export function getPairedRuntimeBrowserClientRouteIdentity(
  environmentId: string
): ClientHostRouteIdentity | null {
  return clientHostRouteIdentities.get(environmentId) ?? null
}

export function pairedRuntimeBrowserClientHostsPage(
  environmentId: string,
  browserPageId: string
): boolean {
  return browserClientHosts.hostsPage(environmentId, browserPageId)
}

export function closePairedRuntimeBrowserClientHostEnvironment(
  environmentId: string,
  error?: Error
): Promise<boolean> {
  if (clientHostRouteIdentities.delete(environmentId)) {
    notifyRouteProfilesChanged()
  }
  return browserClientHosts.closeEnvironment(environmentId, error)
}

/** Waits for pages to release their partitions before callers clear storage. */
export function retirePairedRuntimeBrowserClientHostEnvironment(
  environmentId: string,
  error?: Error
): Promise<boolean> {
  if (clientHostRouteIdentities.delete(environmentId)) {
    notifyRouteProfilesChanged()
  }
  return browserClientHosts.retireEnvironment(environmentId, error)
}

export function shutdownPairedRuntimeBrowserClientHosts(): Promise<void> {
  if (clientHostRouteIdentities.size > 0) {
    clientHostRouteIdentities.clear()
    notifyRouteProfilesChanged()
  }
  return browserClientHosts.close()
}

function createNetworkRoutes(
  connection: PairedRuntimeConnection,
  authority: BrowserClientHostLeaseAuthority,
  authorityStorageKey: string,
  environmentId: string
): BrowserClientNetworkRouteRegistry {
  return new BrowserClientNetworkRouteRegistry({
    authority,
    authorityStorageKey,
    createRoute: (executionHost) =>
      new PairedRuntimeBrowserNetworkRoute({
        connection,
        lease: authority,
        executionHost,
        executionHostRevision: executionHost.kind === 'native' ? executionHost.revision : 0,
        onError: reportBrowserClientHostError,
        // Retire the host after bounded recovery fails so its pages cannot keep issuing doomed requests.
        onUnavailable: (error) => retireFailedEnvironmentHost(environmentId, error)
      })
  })
}

function browserClientFileStagingRoot(environmentId: string): string {
  const scope = createHash('sha256').update(environmentId).digest('hex').slice(0, 16)
  return path.join(app.getPath('temp'), 'orca-browser-file-channel', scope)
}

function reportBrowserClientHostError(error: Error): void {
  console.warn('[browser-client-host] Client host unavailable:', error.message)
}

function retireFailedEnvironmentHost(environmentId: string, error: Error): void {
  reportBrowserClientHostError(error)
  // Retire the route identity too, or cookie imports could target a dead partition.
  void closePairedRuntimeBrowserClientHostEnvironment(environmentId, error).catch((closeError) => {
    console.warn(
      '[browser-client-host] Failed client host retirement:',
      closeError instanceof Error ? closeError.message : String(closeError)
    )
  })
}

function notifyRouteProfilesChanged(): void {
  try {
    browserSessionRegistry.onProfilesChanged?.()
  } catch (error) {
    console.warn('[browser-client-host] Profile notification failed:', error)
  }
}
