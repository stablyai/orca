import { createHash, randomUUID } from 'node:crypto'
import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import type { PairingOffer } from '../../shared/pairing'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { BrowserClientNetworkRouteRegistry } from './browser-client-network-route-registry'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
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

type ProductionBrowserClientHostStart = PairedRuntimeBrowserClientHostStart & {
  pairing: PairingOffer
  orcaProfileId: string
  authorityConnectionIdentity: string
}

const browserHostClientId = randomUUID()
let activeOrcaProfileId: string | null = null

const browserClientHosts =
  new PairedRuntimeBrowserClientHostRegistry<ProductionBrowserClientHostStart>({
    createComposition: (input) =>
      new PairedRuntimeBrowserClientHostComposition({
        createRoutes: (authority) => createNetworkRoutes(input.pairing, authority),
        createExecutor: ({ retainNetworkRoute }) =>
          new BrowserClientPageCommandExecutor({
            orcaProfileId: input.orcaProfileId,
            authorityConnectionIdentity: input.authorityConnectionIdentity,
            retainNetworkRoute,
            selectRenderer: selectBrowserClientPageRenderer,
            routeSessions: browserRouteSessionRegistry,
            routeWebContents: browserRouteWebContentsRegistry
          }),
        createHost: ({ handler, onAuthority, onError }) =>
          new PairedRuntimeBrowserClientHost({
            pairing: input.pairing,
            authorityRuntimeId: input.authorityRuntimeId,
            browserHostClientId,
            hostCapabilities: ['webview'],
            handler,
            onAuthority,
            onError
          }),
        onError: (error) => retireFailedEnvironmentHost(input.environmentId, error)
      })
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
  return browserClientHosts.start({
    environmentId: options.environment.id,
    pairingRevision,
    authorityRuntimeId: options.authorityRuntimeId,
    pairing,
    orcaProfileId,
    authorityConnectionIdentity: authorityConnectionIdentity(
      orcaProfileId,
      options.environment.id,
      pairingRevision,
      options.authorityRuntimeId,
      pairing
    )
  })
}

export function retirePairedRuntimeBrowserClientPage(
  environmentId: string,
  browserPageId: string,
  pageHostGeneration: number
): Promise<boolean> {
  return browserClientHosts.retirePage(environmentId, browserPageId, pageHostGeneration)
}

export function closePairedRuntimeBrowserClientHostEnvironment(
  environmentId: string,
  error?: Error
): Promise<boolean> {
  return browserClientHosts.closeEnvironment(environmentId, error)
}

export function shutdownPairedRuntimeBrowserClientHosts(): Promise<void> {
  return browserClientHosts.close()
}

function createNetworkRoutes(
  pairing: PairingOffer,
  authority: BrowserClientHostLeaseAuthority
): BrowserClientNetworkRouteRegistry {
  return new BrowserClientNetworkRouteRegistry({
    authority,
    createRoute: (executionHost) =>
      new PairedRuntimeBrowserNetworkRoute({
        pairing,
        lease: authority,
        executionHost,
        executionHostRevision: executionHost.kind === 'native' ? executionHost.revision : 0,
        onError: reportBrowserClientHostError
      })
  })
}

function authorityConnectionIdentity(
  orcaProfileId: string,
  environmentId: string,
  pairingRevision: number,
  authorityRuntimeId: string,
  pairing: PairingOffer
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'paired-runtime-browser',
        orcaProfileId,
        environmentId,
        pairingRevision,
        authorityRuntimeId,
        pairing.publicKeyB64,
        pairing.pairedDeviceId ?? null
      ])
    )
    .digest('hex')
  return `paired-runtime:${digest}`
}

function reportBrowserClientHostError(error: Error): void {
  console.warn('[browser-client-host] Client host unavailable:', error.message)
}

function retireFailedEnvironmentHost(environmentId: string, error: Error): void {
  reportBrowserClientHostError(error)
  void browserClientHosts.closeEnvironment(environmentId, error).catch((closeError) => {
    console.warn(
      '[browser-client-host] Failed client host retirement:',
      closeError instanceof Error ? closeError.message : String(closeError)
    )
  })
}
