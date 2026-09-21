import { createHash } from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../shared/browser-client-automation-protocol'
import { BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY } from '../../shared/browser-client-file-channel-protocol'
import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import type { PairingOffer } from '../../shared/pairing'
import {
  getPreferredPairingOffer,
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
import {
  browserRouteSessionRegistry,
  browserRouteWebContentsRegistry
} from './browser-route-session-runtime'

export type ClientHostRouteIdentity = {
  orcaProfileId: string
  authorityConnectionIdentity: string
  executionHostIdentity: string
  /** Pre-migration pair, naming the partition an older build already populated. */
  legacyAuthorityConnectionIdentity: string
  legacyExecutionHostIdentity: string
  storageScope: string
}

type ProductionBrowserClientHostStart = PairedRuntimeBrowserClientHostStart & {
  pairing: PairingOffer
  orcaProfileId: string
  authorityConnectionIdentity: string
  legacyAuthorityConnectionIdentity: string
  storageScope: string
  environmentLabel: string
}

let activeOrcaProfileId: string | null = null
/** Route identity of each live client host, for storage operations without a page. */
const clientHostRouteIdentities = new Map<string, ClientHostRouteIdentity>()

const browserClientHosts =
  new PairedRuntimeBrowserClientHostRegistry<ProductionBrowserClientHostStart>({
    createComposition: (input) => {
      // Why: one transport per composition so an authority replacement rebinds it to the new lease
      // instead of leaving the executor pointed at a fenced one.
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
          createNetworkRoutes(next.pairing, authority, next.storageScope, input.environmentId),
        createExecutor: (next, { retainNetworkRoute, onPageUnavailable }) => {
          executor = new BrowserClientPageCommandExecutor({
            orcaProfileId: next.orcaProfileId,
            authorityConnectionIdentity: next.authorityConnectionIdentity,
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
            pairing: next.pairing,
            authorityRuntimeId: next.authorityRuntimeId,
            browserHostClientId: getBrowserClientHostId(),
            hostCapabilities: [
              'webview',
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
  const pairing = getPreferredPairingOffer(options.environment)
  const storageScope = deriveBrowserRoutePartitionStorageScope({
    orcaProfileId,
    environmentId: options.environment.id
  })
  const routeIdentity: ClientHostRouteIdentity = {
    orcaProfileId,
    storageScope,
    authorityConnectionIdentity: authorityConnectionIdentity(
      orcaProfileId,
      options.environment.id,
      pairingRevision,
      pairing
    ),
    // Why: settings-level operations target the server's own machine, not a nested SSH/WSL host.
    executionHostIdentity: browserAuthorityExecutionHostStorageIdentity(storageScope),
    legacyAuthorityConnectionIdentity: legacyAuthorityConnectionIdentity(
      orcaProfileId,
      options.environment.id,
      pairingRevision,
      options.authorityRuntimeId,
      pairing
    ),
    legacyExecutionHostIdentity: legacyBrowserNativeExecutionHostStorageIdentity(
      options.authorityRuntimeId
    )
  }
  const authority = await browserClientHosts.start({
    environmentId: options.environment.id,
    pairingRevision,
    authorityRuntimeId: options.authorityRuntimeId,
    pairing,
    orcaProfileId,
    storageScope: routeIdentity.storageScope,
    environmentLabel: options.environment.name,
    authorityConnectionIdentity: routeIdentity.authorityConnectionIdentity,
    legacyAuthorityConnectionIdentity: routeIdentity.legacyAuthorityConnectionIdentity
  })
  clientHostRouteIdentities.set(options.environment.id, routeIdentity)
  return authority
}

/**
 * Route identity of the client host serving `environmentId`, or null when the
 * desktop is not hosting that server's pages. Names the environment's own
 * execution host: the target a settings-level cookie import applies to.
 */
export function getPairedRuntimeBrowserClientRouteIdentity(
  environmentId: string
): ClientHostRouteIdentity | null {
  return clientHostRouteIdentities.get(environmentId) ?? null
}

export function closePairedRuntimeBrowserClientHostEnvironment(
  environmentId: string,
  error?: Error
): Promise<boolean> {
  clientHostRouteIdentities.delete(environmentId)
  return browserClientHosts.closeEnvironment(environmentId, error)
}

/**
 * Closes an environment's client host and waits for its pages to be released, so a caller that
 * clears the environment's partition storage runs after the partitions are actually free.
 */
export function retirePairedRuntimeBrowserClientHostEnvironment(
  environmentId: string,
  error?: Error
): Promise<boolean> {
  clientHostRouteIdentities.delete(environmentId)
  return browserClientHosts.retireEnvironment(environmentId, error)
}

export function shutdownPairedRuntimeBrowserClientHosts(): Promise<void> {
  clientHostRouteIdentities.clear()
  return browserClientHosts.close()
}

function createNetworkRoutes(
  pairing: PairingOffer,
  authority: BrowserClientHostLeaseAuthority,
  authorityStorageKey: string,
  environmentId: string
): BrowserClientNetworkRouteRegistry {
  return new BrowserClientNetworkRouteRegistry({
    authority,
    authorityStorageKey,
    createRoute: (executionHost) =>
      new PairedRuntimeBrowserNetworkRoute({
        pairing,
        lease: authority,
        executionHost,
        executionHostRevision: executionHost.kind === 'native' ? executionHost.revision : 0,
        onError: reportBrowserClientHostError,
        // Why: a route that stayed dark after bounded rebuilds leaves every page in the
        // environment black-holing requests, so retire the host instead of warning forever.
        onUnavailable: (error) => retireFailedEnvironmentHost(environmentId, error)
      })
  })
}

/**
 * Storage identity of the connection to a paired server.
 *
 * Every component is a durable client-side record: the environment, its pairing
 * revision, and the server's public key. The server's `authorityRuntimeId` is
 * deliberately absent -- it is a per-process UUID, and hashing it here minted a
 * fresh partition on every remote restart, dropping the user's cookies.
 */
function authorityConnectionIdentity(
  orcaProfileId: string,
  environmentId: string,
  pairingRevision: number,
  pairing: PairingOffer
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser',
    orcaProfileId,
    environmentId,
    pairingRevision,
    pairing.publicKeyB64,
    pairing.pairedDeviceId ?? null
  ])
}

/** Superseded per-process identity, kept only so its partition can be adopted. */
function legacyAuthorityConnectionIdentity(
  orcaProfileId: string,
  environmentId: string,
  pairingRevision: number,
  authorityRuntimeId: string,
  pairing: PairingOffer
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser',
    orcaProfileId,
    environmentId,
    pairingRevision,
    authorityRuntimeId,
    pairing.publicKeyB64,
    pairing.pairedDeviceId ?? null
  ])
}

function connectionIdentityDigest(components: readonly unknown[]): string {
  return `paired-runtime:${createHash('sha256').update(JSON.stringify(components)).digest('hex')}`
}

// Why: staged remote bytes are main-owned scratch, never the user's visible Downloads folder.
function browserClientFileStagingRoot(environmentId: string): string {
  const scope = createHash('sha256').update(environmentId).digest('hex').slice(0, 16)
  return path.join(app.getPath('temp'), 'orca-browser-file-channel', scope)
}

function reportBrowserClientHostError(error: Error): void {
  console.warn('[browser-client-host] Client host unavailable:', error.message)
}

function retireFailedEnvironmentHost(environmentId: string, error: Error): void {
  reportBrowserClientHostError(error)
  // Why: the identity's lifetime is the composition's — a retired host must not keep answering
  // getPairedRuntimeBrowserClientRouteIdentity, or a cookie import writes into a dead partition.
  void closePairedRuntimeBrowserClientHostEnvironment(environmentId, error).catch((closeError) => {
    console.warn(
      '[browser-client-host] Failed client host retirement:',
      closeError instanceof Error ? closeError.message : String(closeError)
    )
  })
}
