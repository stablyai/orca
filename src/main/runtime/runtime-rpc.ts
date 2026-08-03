/* eslint-disable max-lines -- Why: this file is the single security boundary for the bundled CLI — transport setup, auth-token enforcement, admission control, keepalive framing, and orphan-socket sweeping all co-locate deliberately so a reviewer can audit the boundary in one sitting. Splitting this across files would scatter the invariants without reducing complexity. */
// Why: the single security boundary for the bundled CLI — auth-token enforcement, metadata publication, transport orchestration.
import { randomBytes } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeMetadata, RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import type { OrcaRuntimeService } from './orca-runtime'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from './network-exposure-guidance'
import { writeRuntimeMetadata } from './runtime-metadata'
import {
  RUNTIME_METADATA_OWNERSHIP_POLL_MS,
  watchRuntimeMetadataOwnership,
  type RuntimeMetadataOwnershipWatch
} from './runtime-metadata-ownership-watch'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { errorResponse } from './rpc/errors'
import type { RpcMessageContext, RpcTransport } from './rpc/transport'
import { UnixSocketTransport } from './rpc/unix-socket-transport'
import { WebSocketTransport } from './rpc/ws-transport'
import { readWsFallbackPort, writeWsFallbackPort } from './rpc/ws-fallback-port-store'
import type { WebSocket } from 'ws'
import { DeviceRegistry, type DeviceEntry, type DeviceScope } from './device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from './e2ee-keypair'
import { UnpairedDeviceAuthThrottle } from './rpc/unpaired-device-auth-throttle'
import {
  MobileSocketWiring,
  type AuthenticatedMobileSocket,
  type MobileSocketTransportMetadata
} from './rpc/mobile-socket-wiring'
import type { PairingRelay } from '../../shared/mobile-relay-pairing-offer'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import {
  mobileRelayMintFailureFromUnknown,
  type MobileRelayMintFailure
} from '../../shared/mobile-relay-mint-failure'
import {
  RelayRevokeOutbox,
  type RelayDeviceBinding,
  type RelayRevokeOutboxItem
} from './relay/relay-revoke-outbox'
import type {
  DeviceCredentialInstalled,
  PairingGetEndpointsParams,
  PairingGetEndpointsResult,
  PairingProvisionRelayParams
} from '../../shared/mobile-relay-credential-contract'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { resolveAdvertisedPairingEndpoint } from './pairing-endpoint'
import {
  decodeTerminalStreamFrame,
  type TerminalStreamFrame
} from '../../shared/terminal-stream-protocol'

const DEFAULT_WS_PORT = 6768

// Why: STA-2370 — the WS listener defaults to loopback so a desktop with no paired device is not
// reachable from the LAN; it widens to all interfaces only on explicit pairing (or `orca serve`).
const WS_BIND_HOST_LOOPBACK = '127.0.0.1'
const WS_BIND_HOST_ALL_INTERFACES = '0.0.0.0'

type OrcaRuntimeRpcServerOptions = {
  runtime: OrcaRuntimeService
  userDataPath: string
  pid?: number
  platform?: NodeJS.Platform
  enableWebSocket?: boolean
  wsPort?: number
  // Why: true when the caller pinned a port (`orca serve --port`) so bind order prefers it over a stale STA-1511 fallback (#8535).
  preferPinnedWsPort?: boolean
  // Why: STA-2370 — bind the WS listener to all interfaces at startup instead of loopback-until-paired.
  // Only `orca serve` (explicit remote opt-in) and E2E set this; the desktop app widens lazily on pairing.
  exposeNetworkByDefault?: boolean
  webClientRoot?: string
  // Why: test-only overrides for the two constants below; production must not pass these (defaults set by §3.1).
  keepaliveIntervalMs?: number
  longPollCap?: number
  // Why: test-only override for the ownership reclaim cadence.
  metadataOwnershipPollMs?: number
}

export type PairingOfferUnavailableReason =
  | 'websocket_unavailable'
  | 'device_registry_unavailable'
  | 'e2ee_key_unavailable'
  | 'invalid_advertised_endpoint'
  | 'relay_mint_failed'
  | 'network_exposure_failed'

export type PairingOfferUnavailable = {
  available: false
  reason: PairingOfferUnavailableReason
  guidance: string
  /** Present when an Anywhere mint refused to silently fall back to LAN-only. */
  relayFailure?: MobileRelayMintFailure
}

type MobilePairingOfferAvailable = {
  available: true
  pairingUrl: string
  endpoint: string
  deviceId: string
  webClientUrl: string | null
  /** Mode the offer actually encodes. */
  connectionMode: MobilePairingConnectionMode
}

type MobilePairingOffer = PairingOfferUnavailable | MobilePairingOfferAvailable

type PairingIdentityInitialization =
  | { ok: true; deviceRegistry: DeviceRegistry; e2eeKeypair: E2EEKeypair }
  | { ok: false; failure: PairingOfferUnavailable }

function pairingUnavailable(
  reason: PairingOfferUnavailableReason,
  guidance: string
): PairingOfferUnavailable {
  return { available: false, reason, guidance }
}

const DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE =
  'The pairing registry is unavailable. Verify that the Orca data directory is writable.'
const E2EE_KEY_UNAVAILABLE_GUIDANCE =
  'The E2EE identity is unavailable. Verify that the Orca data directory is writable.'

type MobileRelayPairingProvider = {
  createPairingRelay(
    relayDeviceId: string
  ): Promise<{ relay: PairingRelay; binding: RelayDeviceBinding }>
  onDeviceRevokeQueued(item: RelayRevokeOutboxItem): void
  onDemandStateChanged?(): void
  getEndpoints(
    context: MobilePairingConnectionContext,
    params: PairingGetEndpointsParams
  ): Promise<PairingGetEndpointsResult>
  provisionRelay(
    context: MobilePairingConnectionContext,
    params: PairingProvisionRelayParams
  ): Promise<DeviceCredentialInstalled>
}

export type MobilePairingConnectionContext = Readonly<{
  deviceId: string
  connectionId: string
  transport: MobileSocketTransportMetadata
}>

// Why: keepalive frames count as socket activity, resetting both idle timers so long-polls outlive the 30s/60s idle caps. See §3.1.
const KEEPALIVE_INTERVAL_MS = 10_000

// Why: cap long-polls at half the 32-slot connection budget so they can't starve short RPCs; overflow → runtime_busy. See §7 risk #2.
const LONG_POLL_CAP = 16

// Why: orchestration.ask blocks on a human/agent reply for minutes, an order of
// magnitude longer than terminal.wait or check --wait, so a fleet of asking
// workers would otherwise hold every slot and starve the mobile/web/CLI/relay
// clients sharing this runtime. Reserve half the budget for the other classes.
const ASK_LONG_POLL_SHARE = 0.5

function createWebClientUrl(endpoint: string, pairingUrl: string): string {
  const url = new URL(endpoint)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = webClientPathForEndpoint(url.pathname)
  url.search = ''
  // Why: pairing URLs carry full credentials; the fragment keeps them out of proxy logs and Referer headers.
  url.hash = `pairing=${encodeURIComponent(pairingUrl)}`
  return url.toString()
}

function webClientPathForEndpoint(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/web-index.html'
  }
  return `${pathname.replace(/\/$/, '')}/web-index.html`
}

const MOBILE_RPC_METHOD_ALLOWLIST = new Set([
  'accounts.list',
  'accounts.consumeCodexResetCredit',
  'accounts.selectClaude',
  'accounts.selectCodex',
  'accounts.selectCodexForTarget',
  'accounts.subscribe',
  'accounts.unsubscribe',
  'aiVault.listSessions',
  'aiVault.prepareSessionResume',
  'browser.back',
  'browser.dialogAccept',
  'browser.dialogDismiss',
  'browser.forward',
  'browser.goto',
  'browser.keyboardInsertText',
  'browser.keypress',
  'browser.mouseDown',
  'browser.mouseClick',
  'browser.mouseMove',
  'browser.mouseUp',
  'browser.mouseWheel',
  'browser.reload',
  'browser.screencast',
  'browser.screencast.unsubscribe',
  'browser.tabCreate',
  'browser.viewport',
  'clipboard.abortImageUpload',
  'clipboard.appendImageUploadChunk',
  'clipboard.commitImageUpload',
  'clipboard.saveImageAsTempFile',
  'clipboard.startImageUpload',
  'diagnostics.memory',
  'files.browseServerDir',
  'files.createFile',
  'files.list',
  'files.open',
  'files.openDiff',
  'files.read',
  'files.readChunk',
  'files.readDir',
  'files.readPreview',
  'files.readTerminalArtifact',
  'files.readTerminalArtifactPreview',
  'files.resolveTerminalPath',
  'files.searchPaths',
  'files.writeTerminalArtifact',
  'folderWorkspace.list',
  'git.abortMerge',
  'git.abortRebase',
  'git.bulkStage',
  'git.bulkUnstage',
  'git.branchCompare',
  'git.branchDiff',
  'git.cancelGenerateCommitMessage',
  'git.cancelGeneratePullRequestFields',
  'git.checkout',
  'git.commit',
  'git.commitCompare',
  'git.commitDiff',
  'git.discard',
  'git.discoverCommitMessageModels',
  'git.diff',
  'git.fetch',
  'git.forkSync',
  'git.fastForward',
  'git.generateCommitMessage',
  'git.generatePullRequestFields',
  'git.history',
  'git.localBranches',
  'git.pull',
  'git.push',
  'git.rebaseFromBase',
  'git.stage',
  'git.status',
  'git.unstage',
  'git.upstreamStatus',
  'github.createIssue',
  'github.addIssueComment',
  'github.addPRReviewComment',
  'github.addPRReviewCommentReply',
  'github.countWorkItems',
  'github.listAssignableUsers',
  'github.listLabels',
  'github.listWorkItems',
  'github.mergePR',
  'github.setPRAutoMerge',
  'github.requestPRReviewers',
  'github.removePRReviewers',
  'github.project.listAccessible',
  'github.project.listAssignableUsersBySlug',
  'github.project.listIssueTypesBySlug',
  'github.project.listLabelsBySlug',
  'github.project.listViews',
  'github.project.resolveRef',
  'github.project.addIssueCommentBySlug',
  'github.project.updateIssueCommentBySlug',
  'github.project.deleteIssueCommentBySlug',
  'github.project.clearItemField',
  'github.project.updateIssueBySlug',
  'github.project.updateIssueTypeBySlug',
  'github.project.updateItemField',
  'github.project.updatePullRequestBySlug',
  'github.project.viewTable',
  'github.project.workItemDetailsBySlug',
  'github.prForBranch',
  'github.prFileContents',
  'github.prChecks',
  'github.prCheckDetails',
  'github.rerunPRChecks',
  'github.resolveReviewThread',
  'github.setPRFileViewed',
  'github.updateIssue',
  'github.updatePR',
  'github.updatePRTitle',
  'github.updatePRState',
  'github.repoSlug',
  'github.workItem',
  // Cross-repo lookup: lets the mobile Smart picker resolve a pasted github.com URL for a different repo.
  'github.workItemByOwnerRepo',
  'github.workItemDetails',
  'gitlab.createIssue',
  'gitlab.addIssueComment',
  'gitlab.addMRComment',
  'gitlab.listWorkItems',
  // Mobile Smart picker: resolve a pasted GitLab URL to an exact issue/MR (MR listing reuses gitlab.listWorkItems).
  'gitlab.workItemByPath',
  'gitlab.mergeMR',
  'gitlab.resolveMRDiscussion',
  'gitlab.todos',
  'gitlab.updateIssue',
  'gitlab.updateMR',
  'gitlab.updateMRState',
  'gitlab.workItemDetails',
  'host.gitBash.isAvailable',
  'host.platform',
  'host.pwsh.isAvailable',
  'host.wsl.isAvailable',
  'host.wsl.listDistros',
  'hostedReview.create',
  'hostedReview.forBranch',
  'hostedReview.getCreationEligibility',
  'linear.getCustomView',
  'linear.getIssue',
  'linear.getProject',
  'linear.agentSearchIssues',
  'linear.issueContext',
  'linear.resolveCurrentIssue',
  'linear.addIssueComment',
  'linear.connect',
  'linear.createIssue',
  'linear.createProject',
  'linear.issueComments',
  'linear.listCustomViewIssues',
  'linear.listCustomViewProjects',
  'linear.listCustomViews',
  'linear.listIssues',
  'linear.mcpListIssues',
  'linear.listProjectIssues',
  'linear.listProjects',
  'linear.teamLabels',
  'linear.teamMembers',
  'linear.listTeams',
  'linear.searchIssues',
  'linear.selectWorkspace',
  'linear.status',
  'linear.teamStates',
  'linear.updateIssue',
  'markdown.readTab',
  'markdown.saveTab',
  'notifications.getMissedSince',
  'notifications.subscribe',
  'notifications.unsubscribe',
  'pairing.getEndpoints',
  'pairing.provisionRelay',
  'preflight.check',
  'preflight.detectAgents',
  'preflight.detectRemoteAgents',
  'projectGroup.list',
  'repo.baseRefDefault',
  'repo.gitAvailable',
  'repo.hooks',
  'repo.list',
  'repo.saveSparsePreset',
  'repo.searchRefs',
  'repo.sparsePresets',
  'repo.update',
  'runtime.clientEvents.subscribe',
  'runtime.clientEvents.unsubscribe',
  'session.tabs.activate',
  'session.tabs.close',
  'session.tabs.closeLifecycle',
  'session.tabs.createTerminal',
  'session.tabs.list',
  'session.tabs.listAll',
  'session.tabs.move',
  'session.tabs.subscribe',
  'session.tabs.subscribeAll',
  'session.tabs.unsubscribe',
  'session.tabs.unsubscribeAll',
  'nativeChat.readSession',
  'nativeChat.subscribe',
  'nativeChat.unsubscribe',
  'settings.get',
  'settings.getTerminalQuickCommands',
  'settings.update',
  'settings.updateTerminalQuickCommands',
  'ssh.connect',
  'ssh.getState',
  'ssh.listRemovedTargetLabels',
  'ssh.listTargets',
  'ssh.listTargetSummaries',
  'speech.dictation.cancel',
  'speech.dictation.chunk',
  'speech.dictation.finish',
  'speech.dictation.setup',
  'speech.dictation.start',
  'speech.models.delete',
  'speech.models.download',
  'speech.models.list',
  'stats.summary',
  'status.get',
  'agentTeams.prepareLaunch',
  'agentTeams.tmuxCompat',
  'terminal.clearBuffer',
  'terminal.close',
  'terminal.closeTab',
  'terminal.create',
  'terminal.createAgentSession',
  'terminal.ensureAgentSession',
  'terminal.focus',
  'terminal.agentStatus',
  'terminal.adoptOrphans',
  'terminal.getAutoRestoreFit',
  'terminal.isRunningAgent',
  'terminal.list',
  'terminal.multiplex',
  'terminal.read',
  'terminal.rename',
  'terminal.send',
  'terminal.setAutoRestoreFit',
  'terminal.setDisplayMode',
  'terminal.subscribe',
  'terminal.unsubscribe',
  'terminal.updateViewport',
  'terminal.wait',
  'ui.get',
  'ui.recordFeatureInteraction',
  'ui.set',
  'worktree.activate',
  'worktree.create',
  'worktree.forceDeleteBranch',
  'worktree.prefetchCreateBase',
  'worktree.ps',
  'worktree.show',
  'worktree.resolveMrBase',
  'worktree.resolvePrBase',
  'worktree.rm',
  'worktree.set',
  'worktree.sleep'
])

// Why: 'ask' is metered separately from 'wait' — same keepalive/abort wiring, its own sub-cap.
type LongPollClass = 'ask' | 'wait'

// Why: single classifier for long-poll requests (handlers that block on an external event), shared by counter/abort/keepalive. See §3.1.
function longPollClassOf(request: RpcRequest): LongPollClass | null {
  if (request.method === 'terminal.wait') {
    return 'wait'
  }
  // Why: orchestration.ask blocks unconditionally (default 600 s) holding the
  // RPC open until a reply lands or the deadline passes, so it needs the same
  // keepalive as check --wait or the 30 s socket idle timer tears it down. It
  // also relies on the abort signal (only wired for long-polls) to release the
  // waiter when the asking client disconnects.
  if (request.method === 'orchestration.ask') {
    return 'ask'
  }
  if (request.method === 'orchestration.check') {
    const params = request.params as { wait?: unknown } | undefined
    return params?.wait === true ? 'wait' : null
  }
  return null
}

// Why: status.get has no per-connection context in the dispatcher, so stamp the scope here at the transport boundary.
function injectDeviceScope(response: string, scope: DeviceScope): string {
  try {
    const parsed = JSON.parse(response) as RpcResponse
    if (parsed.ok !== true || typeof parsed.result !== 'object' || parsed.result === null) {
      return response
    }
    ;(parsed.result as Record<string, unknown>).deviceScope = scope
    return JSON.stringify(parsed)
  } catch {
    return response
  }
}

export class OrcaRuntimeRpcServer {
  private readonly runtime: OrcaRuntimeService
  private readonly dispatcher: RpcDispatcher
  private readonly userDataPath: string
  private readonly pid: number
  private readonly platform: NodeJS.Platform
  private readonly enableWebSocket: boolean
  private readonly wsPort: number
  private readonly preferPinnedWsPort: boolean
  private readonly exposeNetworkByDefault: boolean
  private readonly webClientRoot: string | undefined
  // Why: STA-2370 — the host the WS listener is currently bound to, so pairing can widen loopback→all-interfaces once.
  private wsBoundHost: string | null = null
  // Why: STA-2370 — in-flight widen so concurrent pairing requests share a single rebind.
  private networkExposurePromise: Promise<void> | null = null
  // Why: STA-2370 — set by stop() so a racing pairing widen can't recreate a live wide listener into the
  // cleared transport arrays after shutdown; stop() also awaits any in-flight widen before snapshotting.
  private stopping = false
  private readonly authToken = randomBytes(24).toString('hex')
  private readonly keepaliveIntervalMs: number
  private readonly longPollCap: number
  private readonly metadataOwnershipPollMs: number
  private readonly askLongPollCap: number
  private readonly relayRevokeOutbox: RelayRevokeOutbox
  private deviceRegistry: DeviceRegistry | null = null
  private e2eeKeypair: E2EEKeypair | null = null
  private pairingInitializationFailure: PairingOfferUnavailable | null = null
  private tlsFingerprint: string | null = null
  private activeTransports: RpcTransport[] = []
  private transports: RuntimeTransportMetadata[] = []
  private metadataOwnershipWatch: RuntimeMetadataOwnershipWatch | null = null
  private mobileSocketWiring: MobileSocketWiring | null = null
  // Why: detaches the current WebSocketTransport from the session wiring so a pairing rebind can swap
  // transports under the SAME wiring (see ensureMobileSocketWiring) instead of orphaning relay sockets.
  private detachWebSocketWiring: (() => void) | null = null
  private mobileRelayPairingProvider: MobileRelayPairingProvider | null = null
  private mobileRelayPairingOfferQueue: Promise<void> = Promise.resolve()
  private mobileRelayPairingOfferInFlight: {
    generation: number
    address: string | null
    rotate: boolean
    request: Promise<MobilePairingOffer>
  } | null = null
  private mobilePairingOfferGeneration = 0
  private onUnpairedDeviceAuthFailure: (() => void) | null = null
  private unpairedDeviceAuthThrottle: UnpairedDeviceAuthThrottle | null = null
  private readonly binaryStreamHandlers = new Map<
    string,
    Map<number, (frame: TerminalStreamFrame) => void>
  >()
  private readonly wsDispatchAbortStates = new Map<
    WebSocket,
    { controllers: Set<AbortController>; abortOnClose: () => void }
  >()
  // Why: separate from server.maxConnections — count only long-running dispatches, not short RPCs. See §3.1 + §7 risk #2.
  private activeLongPolls = 0
  // Why: subset of activeLongPolls held by orchestration.ask, fenced by askLongPollCap.
  private activeAskLongPolls = 0

  constructor({
    runtime,
    userDataPath,
    pid = process.pid,
    platform = process.platform,
    enableWebSocket = false,
    wsPort = DEFAULT_WS_PORT,
    preferPinnedWsPort = false,
    exposeNetworkByDefault = false,
    webClientRoot,
    keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS,
    longPollCap = LONG_POLL_CAP,
    metadataOwnershipPollMs = RUNTIME_METADATA_OWNERSHIP_POLL_MS
  }: OrcaRuntimeRpcServerOptions) {
    this.runtime = runtime
    this.dispatcher = new RpcDispatcher({ runtime })
    this.userDataPath = userDataPath
    this.pid = pid
    this.platform = platform
    this.enableWebSocket = enableWebSocket
    this.wsPort = wsPort
    this.preferPinnedWsPort = preferPinnedWsPort
    this.exposeNetworkByDefault = exposeNetworkByDefault
    this.webClientRoot = webClientRoot
    this.keepaliveIntervalMs = keepaliveIntervalMs
    this.longPollCap = longPollCap
    this.metadataOwnershipPollMs = metadataOwnershipPollMs
    // Why: derived, not configurable — the reservation must hold for whatever cap a caller picks.
    this.askLongPollCap = Math.max(1, Math.floor(longPollCap * ASK_LONG_POLL_SHARE))
    this.relayRevokeOutbox = new RelayRevokeOutbox(userDataPath)
  }

  getDeviceRegistry(): DeviceRegistry | null {
    return this.deviceRegistry
  }

  getTlsFingerprint(): string | null {
    return this.tlsFingerprint
  }

  getE2EEPublicKey(): string | null {
    return this.e2eeKeypair?.publicKeyB64 ?? null
  }

  getE2EEKeypair(): E2EEKeypair | null {
    return this.e2eeKeypair
  }

  getMobileSocketWiring(): MobileSocketWiring | null {
    return this.mobileSocketWiring
  }

  getRelayRevokeOutbox(): RelayRevokeOutbox {
    return this.relayRevokeOutbox
  }

  setMobileRelayBinding(deviceId: string, binding: RelayDeviceBinding): boolean {
    const current = this.deviceRegistry?.getDevice(deviceId)
    if (
      current?.scope !== 'mobile' ||
      this.deviceRegistry?.getMobilePairingConnectionMode(deviceId) === 'local-only'
    ) {
      return false
    }
    if (
      current.relayBinding &&
      (current.relayBinding.relayHostId !== binding.relayHostId ||
        current.relayBinding.ownerIdentityKey !== binding.ownerIdentityKey)
    ) {
      // Why: switching the owning account/host must not strand the old cloud credential family, even if that account is offline.
      if (!this.queueRelayDeviceRevoke(current.relayBinding)) {
        return false
      }
    }
    const updated = this.deviceRegistry?.setRelayBinding(deviceId, binding) ?? false
    if (updated) {
      this.mobileRelayPairingProvider?.onDemandStateChanged?.()
    }
    return updated
  }

  // Why: only the desktop shell can surface UI; headless serve leaves this unset.
  setOnUnpairedDeviceAuthFailure(callback: (() => void) | null): void {
    this.onUnpairedDeviceAuthFailure = callback
  }

  setMobileRelayPairingProvider(provider: MobileRelayPairingProvider | null): void {
    this.mobileRelayPairingProvider = provider
  }

  async revokeMobileDevice(deviceId: string): Promise<boolean> {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'mobile') {
      return false
    }
    if (device.relayBinding) {
      if (!this.queueRelayDeviceRevoke(device.relayBinding)) {
        return false
      }
    }
    if (!this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.mobileRelayPairingProvider?.onDemandStateChanged?.()
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(device.token)
    return true
  }

  revokeRuntimeAccess(deviceId: string): boolean {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'runtime' || !this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(device.token)
    return true
  }

  getWebSocketEndpoint(): string | null {
    const ws = this.transports.find((t) => t.kind === 'websocket')
    return ws?.endpoint ?? null
  }

  createPairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
    scope?: DeviceScope
  }):
    | PairingOfferUnavailable
    | {
        available: true
        pairingUrl: string
        endpoint: string
        deviceId: string
        webClientUrl: string | null
      } {
    if (this.pairingInitializationFailure) {
      return this.pairingInitializationFailure
    }
    const rawEndpoint = this.getWebSocketEndpoint()
    if (!rawEndpoint) {
      return pairingUnavailable(
        'websocket_unavailable',
        'WebSocket pairing is unavailable. Inspect preceding runtime errors and choose an unused --port if the listener failed.'
      )
    }
    if (!this.deviceRegistry) {
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!publicKeyB64) {
      return pairingUnavailable('e2ee_key_unavailable', E2EE_KEY_UNAVAILABLE_GUIDANCE)
    }

    const advertised = resolveAdvertisedPairingEndpoint(rawEndpoint, args.address)
    if (!advertised.ok) {
      return pairingUnavailable(advertised.reason, advertised.guidance)
    }
    const endpoint = advertised.endpoint
    const deviceName = args.name ?? `CLI ${new Date().toLocaleDateString()}`
    const scope = args.scope ?? 'runtime'
    let device: DeviceEntry
    try {
      device = args.rotate
        ? this.deviceRegistry.rotatePendingDevice(deviceName, scope)
        : this.deviceRegistry.getOrCreatePendingDevice(deviceName, scope)
    } catch (error) {
      console.error('[runtime] Failed to persist pairing credential:', error)
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    const pairingUrl = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint,
      deviceToken: device.token,
      publicKeyB64,
      scope
    })
    return {
      available: true,
      pairingUrl,
      endpoint,
      deviceId: device.deviceId,
      webClientUrl:
        this.webClientRoot && scope === 'runtime' ? createWebClientUrl(endpoint, pairingUrl) : null
    }
  }

  async createMobilePairingOffer(args: {
    address?: string | null
    connectionMode?: MobilePairingConnectionMode
    name?: string
    rotate?: boolean
  }): Promise<MobilePairingOffer> {
    // Why: STA-2370 — creating a mobile pairing offer is the user's explicit opt-in to LAN reach, so
    // widen the loopback listener before advertising its LAN endpoint in the QR. If the widen fails the
    // listener stays on loopback, so report unavailable rather than advertise a dead LAN endpoint.
    try {
      await this.ensureNetworkExposure()
    } catch (error) {
      console.error(
        '[runtime] Network exposure failed while creating a mobile pairing offer:',
        error
      )
      return pairingUnavailable('network_exposure_failed', NETWORK_EXPOSURE_FAILED_GUIDANCE)
    }
    if (args.connectionMode === 'local-only') {
      this.mobilePairingOfferGeneration += 1
      return this.createMobilePairingOfferSerial(args, this.mobilePairingOfferGeneration)
    }
    const address = args.address ?? null
    const rotate = args.rotate === true
    const inFlight = this.mobileRelayPairingOfferInFlight
    if (
      inFlight?.generation === this.mobilePairingOfferGeneration &&
      inFlight.address === address &&
      (inFlight.rotate || !rotate)
    ) {
      return inFlight.request
    }
    // Why: every request that is not coalesced above supersedes the older one, rotating or not.
    const generation = ++this.mobilePairingOfferGeneration
    const request = this.mobileRelayPairingOfferQueue.then(() =>
      generation === this.mobilePairingOfferGeneration
        ? this.createMobilePairingOfferSerial(args, generation)
        : this.relayPairingRequestSuperseded()
    )
    this.mobileRelayPairingOfferQueue = request.then(
      () => undefined,
      () => undefined
    )
    this.mobileRelayPairingOfferInFlight = { generation, address, rotate, request }
    void request.then(
      () => {
        if (this.mobileRelayPairingOfferInFlight?.request === request) {
          this.mobileRelayPairingOfferInFlight = null
        }
      },
      () => {
        if (this.mobileRelayPairingOfferInFlight?.request === request) {
          this.mobileRelayPairingOfferInFlight = null
        }
      }
    )
    return request
  }

  private async createMobilePairingOfferSerial(
    args: {
      address?: string | null
      connectionMode?: MobilePairingConnectionMode
      name?: string
      rotate?: boolean
    },
    generation: number
  ): Promise<MobilePairingOffer> {
    // Why: the renderer is outside the trust boundary, so only an explicit local-only value may suppress Relay provisioning.
    const connectionMode = args.connectionMode === 'local-only' ? 'local-only' : 'automatic'
    const pending = this.deviceRegistry?.getPendingDevice('mobile')
    // Why: connection policy is part of the credential, so rotate on any policy switch — an old-policy QR must not pair under the new one.
    const switchingPendingMode =
      pending != null &&
      this.deviceRegistry?.getMobilePairingConnectionMode(pending.deviceId) !== connectionMode
    if (args.rotate || switchingPendingMode) {
      if (pending?.relayBinding) {
        // Why: record the durable cloud revoke before rotating the local token so an old relay invite can't outlive the QR.
        if (!this.queueRelayDeviceRevoke(pending.relayBinding)) {
          return pairingUnavailable(
            'device_registry_unavailable',
            'Could not persist Relay cleanup before rotating the pairing code.'
          )
        }
      }
    }
    const direct = this.createPairingOffer({
      ...args,
      rotate: args.rotate || switchingPendingMode,
      scope: 'mobile'
    })
    if (!direct.available) {
      return direct
    }
    const createdNewPendingDevice = pending?.deviceId !== direct.deviceId
    let connectionModeStored = false
    try {
      connectionModeStored =
        this.deviceRegistry?.setMobilePairingConnectionMode(direct.deviceId, connectionMode) ??
        false
    } catch (error) {
      console.error('[runtime] Failed to persist the pairing connection mode:', error)
    }
    // Why: the mode is part of the credential — a QR whose policy was never stored must not pair under the default one.
    if (!connectionModeStored) {
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    // Why: explicit LAN path never needs Relay; mint the direct-only offer as selected.
    if (connectionMode === 'local-only') {
      return { ...direct, connectionMode: 'local-only' }
    }
    // Why: Anywhere must not silently ship a LAN-only QR under the Relay label.
    // Fail closed, drop the unused pending credential, and let the UI offer Use LAN.
    const refuseAutomaticWithoutRelay = (
      relayFailure: MobileRelayMintFailure
    ): PairingOfferUnavailable => {
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return {
        available: false,
        reason: 'relay_mint_failed',
        guidance:
          'Orca Relay could not create a pairing invite. Use LAN (Tailscale or same Wi‑Fi) or retry Relay.',
        relayFailure
      }
    }
    const relayProvider = this.mobileRelayPairingProvider
    if (!relayProvider) {
      return refuseAutomaticWithoutRelay({
        code: 'relay_provider_unavailable',
        stage: 'provider_missing',
        message: 'Orca Relay is not available on this desktop'
      })
    }
    const device = this.deviceRegistry?.getDevice(direct.deviceId)
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!device || !publicKeyB64) {
      return refuseAutomaticWithoutRelay({
        code: 'e2ee_key_unavailable',
        stage: 'e2ee_missing',
        message: 'E2EE public key unavailable for Relay pairing'
      })
    }
    let relayPairing: Awaited<ReturnType<MobileRelayPairingProvider['createPairingRelay']>>
    try {
      relayPairing = await relayProvider.createPairingRelay(device.deviceId)
    } catch (error) {
      // Why: the raw provider error can carry request metadata or credentials — log only the validated code.
      const relayFailure = mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error,
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
      console.warn(`[runtime] Failed to create Relay pairing invite: ${relayFailure.code}`)
      return refuseAutomaticWithoutRelay(relayFailure)
    }
    const currentDevice = this.deviceRegistry?.getDevice(device.deviceId)
    if (
      generation !== this.mobilePairingOfferGeneration ||
      relayProvider !== this.mobileRelayPairingProvider ||
      currentDevice?.token !== device.token ||
      this.deviceRegistry?.getMobilePairingConnectionMode(device.deviceId) !== 'automatic'
    ) {
      this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return this.relayPairingRequestSuperseded()
    }
    try {
      if (!this.setMobileRelayBinding(device.deviceId, relayPairing.binding)) {
        this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
        return refuseAutomaticWithoutRelay({
          code: 'relay_binding_failed',
          stage: 'binding_failed',
          message: 'Could not store Relay binding for the pairing device'
        })
      }
    } catch (error) {
      console.warn('[runtime] Failed to persist Relay pairing binding:', error)
      this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
      return refuseAutomaticWithoutRelay({
        code: 'relay_binding_failed',
        stage: 'binding_failed',
        message: 'Could not store Relay binding for the pairing device'
      })
    }
    return {
      ...direct,
      connectionMode: 'automatic',
      pairingUrl: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint: direct.endpoint,
        deviceToken: device.token,
        publicKeyB64,
        scope: 'mobile',
        relay: relayPairing.relay
      })
    }
  }

  private relayPairingRequestSuperseded(): PairingOfferUnavailable {
    return {
      available: false,
      reason: 'relay_mint_failed',
      guidance: 'The Relay pairing request was replaced by a newer connection choice.',
      relayFailure: {
        code: 'relay_request_superseded',
        stage: 'binding_failed',
        message: 'Relay pairing request superseded'
      }
    }
  }

  /** Drop a never-scanned mobile pending credential after a failed Anywhere mint. */
  private discardPendingMobilePairingDevice(deviceId: string): void {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (!device || device.scope !== 'mobile' || device.lastSeenAt !== 0) {
      return
    }
    if (device.relayBinding) {
      if (!this.queueRelayDeviceRevoke(device.relayBinding)) {
        return
      }
    }
    try {
      this.deviceRegistry?.removeDevice(deviceId)
    } catch (error) {
      console.error('[runtime] Failed to drop an unused mobile pairing credential:', error)
    }
  }

  /**
   * Why: the outbox is the only durable cleanup record for a minted invite. When it can't be
   * written, keep the binding on the device so cleanup keeps a reference instead of orphaning it.
   */
  private queueOrRetainRelayDeviceRevoke(deviceId: string, binding: RelayDeviceBinding): void {
    if (this.queueRelayDeviceRevoke(binding)) {
      return
    }
    try {
      this.deviceRegistry?.setRelayBinding(deviceId, binding)
    } catch (error) {
      console.error('[runtime] Failed to retain an unrevoked Relay binding:', error)
    }
  }

  private queueRelayDeviceRevoke(binding: RelayDeviceBinding): boolean {
    let item: RelayRevokeOutboxItem
    try {
      item = this.relayRevokeOutbox.enqueue(binding)
    } catch (error) {
      console.error('[runtime] Failed to persist Relay device cleanup:', error)
      return false
    }
    try {
      this.mobileRelayPairingProvider?.onDeviceRevokeQueued(item)
    } catch (error) {
      console.warn('[runtime] Failed to notify Relay cleanup worker:', error)
    }
    return true
  }

  private registerBinaryStreamHandler(
    connectionId: string | undefined,
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ): () => void {
    if (!connectionId || !Number.isInteger(streamId) || streamId < 0) {
      return () => {}
    }
    let handlers = this.binaryStreamHandlers.get(connectionId)
    if (!handlers) {
      handlers = new Map()
      this.binaryStreamHandlers.set(connectionId, handlers)
    }
    handlers.set(streamId, handler)
    return () => {
      const current = this.binaryStreamHandlers.get(connectionId)
      if (!current || current.get(streamId) !== handler) {
        return
      }
      current.delete(streamId)
      if (current.size === 0) {
        this.binaryStreamHandlers.delete(connectionId)
      }
    }
  }

  private handleWebSocketBinaryMessage(bytes: Uint8Array<ArrayBufferLike>, ws: WebSocket): void {
    const connectionId = this.mobileSocketWiring?.getConnectionId(ws)
    if (!connectionId) {
      return
    }
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return
    }
    this.binaryStreamHandlers.get(connectionId)?.get(frame.streamId)?.(frame)
  }

  private registerWebSocketDispatchAbort(ws: WebSocket): {
    signal: AbortSignal
    dispose: () => void
  } {
    const abortController = new AbortController()
    if (ws.readyState !== ws.OPEN) {
      abortController.abort()
      return { signal: abortController.signal, dispose: () => {} }
    }

    let state = this.wsDispatchAbortStates.get(ws)
    if (!state) {
      state = {
        controllers: new Set(),
        abortOnClose: () => this.abortWebSocketDispatches(ws)
      }
      this.wsDispatchAbortStates.set(ws, state)
      // Why: many streaming RPCs share one WebSocket; one socket-level abort fan-out avoids MaxListenersExceededWarning.
      ws.on('close', state.abortOnClose)
      ws.on('error', state.abortOnClose)
    }
    state.controllers.add(abortController)

    return {
      signal: abortController.signal,
      dispose: () => {
        const current = this.wsDispatchAbortStates.get(ws)
        if (!current) {
          return
        }
        current.controllers.delete(abortController)
        if (current.controllers.size > 0) {
          return
        }
        this.wsDispatchAbortStates.delete(ws)
        ws.off('close', current.abortOnClose)
        ws.off('error', current.abortOnClose)
      }
    }
  }

  private abortWebSocketDispatches(ws: WebSocket): void {
    const state = this.wsDispatchAbortStates.get(ws)
    if (!state) {
      return
    }
    this.wsDispatchAbortStates.delete(ws)
    ws.off('close', state.abortOnClose)
    ws.off('error', state.abortOnClose)
    for (const controller of state.controllers) {
      controller.abort()
    }
    state.controllers.clear()
  }

  private initializePairingIdentity(): PairingIdentityInitialization {
    let deviceRegistry: DeviceRegistry
    try {
      deviceRegistry = new DeviceRegistry(this.userDataPath)
    } catch (error) {
      console.error('[runtime] Failed to initialize pairing registry:', error)
      return {
        ok: false,
        failure: pairingUnavailable(
          'device_registry_unavailable',
          DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE
        )
      }
    }
    let e2eeKeypair: E2EEKeypair
    try {
      e2eeKeypair = loadOrCreateE2EEKeypair(this.userDataPath)
    } catch (error) {
      console.error('[runtime] Failed to initialize E2EE identity:', error)
      return {
        ok: false,
        failure: pairingUnavailable('e2ee_key_unavailable', E2EE_KEY_UNAVAILABLE_GUIDANCE)
      }
    }
    return { ok: true, deviceRegistry, e2eeKeypair }
  }

  async start(): Promise<void> {
    if (this.activeTransports.length > 0) {
      return
    }

    // Why: SIGKILL/OOM skip stop(), orphaning `o-<pid>-*.sock` files; sweep them. Skipped on Windows: named pipes leave no filesystem entries.
    if (this.platform !== 'win32') {
      sweepOrphanedRuntimeSockets(this.userDataPath, this.pid)
    }

    const transportMeta = createRuntimeTransportMetadata(
      this.userDataPath,
      this.pid,
      this.platform,
      this.runtime.getRuntimeId()
    )

    const socketTransport = new UnixSocketTransport({
      endpoint: transportMeta.endpoint,
      kind: transportMeta.kind as 'unix' | 'named-pipe',
      keepaliveIntervalMs: this.keepaliveIntervalMs
    })

    // Why: the `.catch` guarantees reply() always fires so a throw can't strand the client or leak the AbortController.
    socketTransport.onMessage((msg, reply, context) => {
      void this.handleMessage(msg, context)
        .then((response) => {
          reply(JSON.stringify(response))
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          // Why: best-effort id recovery so the client can correlate the error frame to its pending request.
          let id = 'unknown'
          try {
            const parsed = JSON.parse(msg) as { id?: unknown }
            if (typeof parsed.id === 'string' && parsed.id.length > 0) {
              id = parsed.id
            }
          } catch {
            // ignore — fall through with id='unknown'
          }
          reply(JSON.stringify(this.buildError(id, 'internal_error', message)))
        })
    })

    await socketTransport.start()

    const activeTransports: RpcTransport[] = [socketTransport]
    const transportsMeta: RuntimeTransportMetadata[] = [transportMeta]

    // Why: WebSocket uses per-device tokens + E2EE (tweetnacl) instead of TLS since React Native can't pin self-signed certs.
    if (this.enableWebSocket) {
      const pairingIdentity = this.initializePairingIdentity()
      if (!pairingIdentity.ok) {
        this.deviceRegistry = null
        this.e2eeKeypair = null
        this.pairingInitializationFailure = pairingIdentity.failure
      } else {
        this.deviceRegistry = pairingIdentity.deviceRegistry
        this.e2eeKeypair = pairingIdentity.e2eeKeypair
        this.pairingInitializationFailure = null
        try {
          const host = this.resolveInitialWebSocketBindHost()
          const { transport, endpoint } = await this.startWebSocketTransport({
            host,
            port: this.wsPort,
            preferPinnedPort: this.preferPinnedWsPort,
            // Why: stable fallback port across restarts keeps paired devices' endpoints valid (STA-1511); wsPort 0 = random (E2E).
            ...(this.wsPort !== 0 ? { fallbackPort: readWsFallbackPort(this.userDataPath) } : {})
          })
          if (this.wsPort !== 0 && transport.resolvedPort !== this.wsPort) {
            writeWsFallbackPort(this.userDataPath, transport.resolvedPort)
          }
          activeTransports.push(transport)
          transportsMeta.push({ kind: 'websocket', endpoint })
        } catch (error) {
          // Why: WebSocket transport is supplementary; on failure (e.g. port in use) continue with Unix socket only.
          console.error('[runtime] Failed to start WebSocket transport:', error)
          this.mobileSocketWiring = null
        }
      }
    }

    // Why: set in-memory transport state before writing metadata so the bootstrap file has the real endpoint/token pair.
    this.activeTransports = activeTransports
    this.transports = transportsMeta

    try {
      this.writeMetadata()
    } catch (error) {
      // Why: a runtime that can't publish metadata is invisible to the CLI — close transports rather than run undiscoverable.
      this.activeTransports = []
      this.transports = []
      await Promise.all(activeTransports.map((t) => t.stop().catch(() => {}))).catch(() => {})
      throw error
    }

    this.metadataOwnershipWatch = watchRuntimeMetadataOwnership({
      userDataPath: this.userDataPath,
      ownedPid: this.pid,
      ownedRuntimeId: this.runtime.getRuntimeId(),
      pollIntervalMs: this.metadataOwnershipPollMs,
      republish: () => {
        // Why: never advertise endpoints we already tore down.
        if (this.activeTransports.length === 0) {
          return
        }
        this.writeMetadata()
      },
      onReclaim: (previous) => {
        console.warn(
          `[runtime] Reclaimed orca-runtime.json from a dead runtime (pid ${previous?.pid ?? 'none'}); republished pid ${this.pid}.`
        )
      }
    })
  }

  // Why: STA-2370 — a desktop with no previously-connected device stays on loopback until the user
  // explicitly pairs; `orca serve`/E2E (exposeNetworkByDefault) and a reconnecting paired device bind wide.
  private resolveInitialWebSocketBindHost(): string {
    if (this.exposeNetworkByDefault) {
      return WS_BIND_HOST_ALL_INTERFACES
    }
    const hasConnectedDevice =
      this.deviceRegistry?.listDevices().some((device) => device.lastSeenAt > 0) ?? false
    return hasConnectedDevice ? WS_BIND_HOST_ALL_INTERFACES : WS_BIND_HOST_LOOPBACK
  }

  // Why: builds and starts a WS transport bound to `host`, wiring the session-scoped mobile socket
  // handlers. Shared by initial start() and the pairing-time widen so both paths stay identical.
  private async startWebSocketTransport(options: {
    host: string
    port: number
    preferPinnedPort: boolean
    fallbackPort?: number
  }): Promise<{ transport: WebSocketTransport; endpoint: string }> {
    const deviceRegistry = this.deviceRegistry
    const e2eeKeypair = this.e2eeKeypair
    if (!deviceRegistry || !e2eeKeypair) {
      throw new Error('WebSocket transport requires an initialized pairing identity')
    }
    const wsTransport = new WebSocketTransport({
      host: options.host,
      port: options.port,
      staticRoot: this.webClientRoot,
      ...(options.fallbackPort !== undefined ? { fallbackPort: options.fallbackPort } : {}),
      ...(options.preferPinnedPort ? { preferPinnedPort: true } : {})
    })
    const mobileSocketWiring = this.ensureMobileSocketWiring(deviceRegistry, e2eeKeypair)
    this.detachWebSocketWiring = mobileSocketWiring.attachTransport(wsTransport)

    try {
      await wsTransport.start()
    } catch (error) {
      // Why: a listener that never bound must not stay attached to the session wiring (it would leak into
      // terminateDeviceConnections); detach before propagating so the wiring only tracks live transports.
      this.detachWebSocketWiring?.()
      this.detachWebSocketWiring = null
      throw error
    }
    this.wsBoundHost = options.host
    return {
      transport: wsTransport,
      endpoint: `ws://${options.host}:${wsTransport.resolvedPort}`
    }
  }

  // Why: one MobileSocketWiring per server session. Direct WS and cloud relay both attach to it, and
  // DesktopRelayService captures it once at construction, so a loopback→wide pairing rebind must swap the
  // transport under the SAME wiring — replacing the wiring would strand relay sockets (lost connection IDs,
  // binary handling, and revocation targeting) on a dead object.
  private ensureMobileSocketWiring(
    deviceRegistry: DeviceRegistry,
    e2eeKeypair: E2EEKeypair
  ): MobileSocketWiring {
    if (this.mobileSocketWiring) {
      return this.mobileSocketWiring
    }
    // Why: session-scoped so each desktop launch may notify once (a mid-session rebind must not reset it).
    this.unpairedDeviceAuthThrottle = new UnpairedDeviceAuthThrottle({
      onTrigger: () => this.onUnpairedDeviceAuthFailure?.()
    })
    const mobileSocketWiring = new MobileSocketWiring({
      deviceRegistry,
      e2eeKeypair,
      onText: (socket, plaintext, reply, sendBinary) => {
        void this.handleWebSocketMessage(
          plaintext,
          reply,
          sendBinary,
          undefined,
          socket.ws,
          socket.device.deviceToken,
          socket
        )
      },
      onBinary: (socket, bytes) => this.handleWebSocketBinaryMessage(bytes, socket.ws),
      onReady: () => {
        // Why: first authenticated mobile/remote client (direct WS and
        // cloud relay both attach here) starts path-candidate tracking.
        // Activation is a local-host concern: candidate buffers live on the
        // buffer-owning host's runtime, so a remote runtime proxy may
        // legitimately lack this method (its own server activates it).
        this.runtime.activateRecentPtyPathCandidateTracking?.()
        this.mobileRelayPairingProvider?.onDemandStateChanged?.()
      },
      onClose: (socket, hasOtherConnections) => {
        if (!socket) {
          return
        }
        this.abortWebSocketDispatches(socket.ws)
        // Why: subscriptions and binary streams are socket-scoped, but disconnect state is device-scoped across transports.
        this.runtime.cleanupSubscriptionsForConnection(socket.connectionId)
        this.runtime.cancelMobileDictationForConnection(socket.connectionId)
        this.binaryStreamHandlers.delete(socket.connectionId)
        if (!hasOtherConnections) {
          this.runtime.onClientDisconnected(socket.device.deviceToken)
        }
      },
      // Why: relay attempts are authorized upstream; only direct failures should prompt local re-pairing.
      onUnpairedDeviceAuthFailure: (metadata) => {
        if (metadata.transport === 'direct') {
          this.unpairedDeviceAuthThrottle?.recordFailure()
        }
      }
    })
    this.mobileSocketWiring = mobileSocketWiring
    return mobileSocketWiring
  }

  // Why: STA-2370 — widen the loopback listener to all interfaces so a freshly generated pairing
  // offer's advertised LAN endpoint is reachable. Idempotent and only ever runs on the first opt-in
  // (before any device has connected), so no live socket is disrupted; the resolved port is reused so
  // an already-issued endpoint stays valid.
  async ensureNetworkExposure(): Promise<void> {
    if (
      !this.enableWebSocket ||
      this.stopping ||
      this.wsBoundHost === WS_BIND_HOST_ALL_INTERFACES
    ) {
      return
    }
    // Why: concurrent pairing requests must share one rebind — two simultaneous stop/start races would
    // fight for the port and strand the listener on a random one.
    if (!this.networkExposurePromise) {
      this.networkExposurePromise = this.widenWebSocketBind().finally(() => {
        this.networkExposurePromise = null
      })
    }
    return this.networkExposurePromise
  }

  private async widenWebSocketBind(): Promise<void> {
    const current = this.activeTransports.find(
      (transport): transport is WebSocketTransport => transport instanceof WebSocketTransport
    )
    if (!current) {
      return
    }
    const index = this.activeTransports.indexOf(current)
    const previousPort = current.resolvedPort
    let widened: { transport: WebSocketTransport; endpoint: string }
    try {
      // Why: detach the loopback listener from the session wiring before stopping it so terminateDevice-
      // Connections never iterates a dead transport; the new listener re-attaches to the SAME wiring.
      this.detachWebSocketWiring?.()
      await current.stop()
      widened = await this.startWebSocketTransport({
        host: WS_BIND_HOST_ALL_INTERFACES,
        port: previousPort,
        preferPinnedPort: true
      })
    } catch (error) {
      // Why: the wide bind failed after the loopback listener was already stopped. Restore a serving
      // loopback listener on the same port (wsBoundHost stays loopback so a later offer retries), then
      // propagate — the caller must not advertise a LAN endpoint with no LAN listener behind it (STA-2370).
      console.error('[runtime] Failed to widen WebSocket transport for pairing:', error)
      await this.recoverWebSocketBindAfterFailedWiden(index, previousPort)
      throw error
    }
    // Why: register the live wide transport BEFORE persisting metadata so a metadata-write failure can
    // never orphan a running 0.0.0.0 listener outside activeTransports (and thus outside stop()).
    this.activeTransports[index] = widened.transport
    const metaIndex = this.transports.findIndex((meta) => meta.kind === 'websocket')
    if (metaIndex >= 0) {
      this.transports[metaIndex] = { kind: 'websocket', endpoint: widened.endpoint }
    }
    try {
      // Why: a rebind that lands on a different port (same-port bind refused) must be persisted so a
      // later reconnect from a device paired to this port matches on the next launch (STA-1511).
      if (this.wsPort !== 0 && widened.transport.resolvedPort !== this.wsPort) {
        writeWsFallbackPort(this.userDataPath, widened.transport.resolvedPort)
      }
      this.writeMetadata()
    } catch (persistError) {
      // Why: the wide listener is live and tracked; a persistence failure must not tear it down. Keep
      // serving — the in-memory endpoint is already correct.
      console.error(
        '[runtime] Widened WebSocket listener but failed to persist pairing metadata:',
        persistError
      )
    }
  }

  // Why: a failed widen already tore down the loopback listener; bring one back on the same host/port so the
  // runtime keeps serving locally (wsBoundHost stays loopback, so the next pairing offer retries the widen).
  private async recoverWebSocketBindAfterFailedWiden(
    index: number,
    previousPort: number
  ): Promise<void> {
    let restored: { transport: WebSocketTransport; endpoint: string }
    try {
      restored = await this.startWebSocketTransport({
        host: WS_BIND_HOST_LOOPBACK,
        port: previousPort,
        preferPinnedPort: true
      })
    } catch (recoveryError) {
      // Why: even the loopback restore failed — drop the dead WebSocket transport so we never advertise an
      // endpoint with no listener. The Unix socket keeps serving and a restart re-establishes the listener.
      console.error(
        '[runtime] Failed to restore WebSocket transport after widen failure:',
        recoveryError
      )
      this.activeTransports.splice(index, 1)
      const metaIndex = this.transports.findIndex((meta) => meta.kind === 'websocket')
      if (metaIndex >= 0) {
        this.transports.splice(metaIndex, 1)
      }
      this.wsBoundHost = null
      try {
        this.writeMetadata()
      } catch {
        // Why: metadata already reflects the torn-down listener; nothing else to recover here.
      }
      return
    }
    // Why: register the restored loopback listener BEFORE persisting metadata so a write failure can never
    // orphan a live transport outside activeTransports (and thus outside stop()).
    this.activeTransports[index] = restored.transport
    const metaIndex = this.transports.findIndex((meta) => meta.kind === 'websocket')
    if (metaIndex >= 0) {
      this.transports[metaIndex] = { kind: 'websocket', endpoint: restored.endpoint }
    }
    try {
      this.writeMetadata()
    } catch (persistError) {
      // Why: the loopback listener is live and tracked; a persistence failure must not tear it down.
      console.error(
        '[runtime] Restored loopback WebSocket listener but failed to persist metadata:',
        persistError
      )
    }
  }

  /** Why: test-only seam — runs one ownership check instead of waiting out the poll interval. */
  checkRuntimeMetadataOwnership(): void {
    this.metadataOwnershipWatch?.check()
  }

  async stop(): Promise<void> {
    // Why: STA-2370 — refuse new widens, then let any in-flight pairing widen settle into the live
    // transport arrays before snapshotting them, so a racing rebind can't strand a wide 0.0.0.0 listener
    // by writing it back into a cleared array after shutdown (see widenWebSocketBind).
    this.stopping = true
    const pendingExposure = this.networkExposurePromise
    if (pendingExposure) {
      await pendingExposure.catch(() => {
        // Why: a failed widen already recovered/logged; we only need it to finish mutating the arrays.
      })
    }
    const transports = this.activeTransports
    this.activeTransports = []
    this.transports = []
    this.metadataOwnershipWatch?.stop()
    this.metadataOwnershipWatch = null
    this.mobileSocketWiring = null
    this.detachWebSocketWiring = null
    if (transports.length === 0) {
      return
    }
    await Promise.all(transports.map((t) => t.stop()))
    // Why: leave the metadata file on shutdown — shared userData may host another live runtime whose bootstrap file we'd erase.
  }

  // Why: Unix socket dispatch is one-shot and auths via the shared token from the 0o600 metadata file. See §3.1.
  private async handleMessage(
    rawMessage: string,
    context?: RpcMessageContext
  ): Promise<RpcResponse> {
    // Why: the transport sends an empty message when a client exceeds max size, then closes the connection.
    if (!rawMessage) {
      return this.buildError('unknown', 'request_too_large', 'RPC request exceeds the maximum size')
    }

    const parsed = this.parseAndAuth(rawMessage)
    if ('error' in parsed) {
      return parsed.error
    }
    const request = parsed.request

    // Why: long-poll admission fence; short RPCs bypass the counter. See §7 risk #2.
    const longPoll = longPollClassOf(request)
    const rejection = this.admitLongPoll(longPoll)
    if (rejection) {
      return this.buildError(request.id, 'runtime_busy', rejection)
    }
    if (longPoll) {
      // Why: arm keepalive only for long-polls; short RPCs never create the setInterval. See §3.1.
      context?.startKeepalive()
    }

    try {
      return await this.dispatcher.dispatch(request, {
        signal: longPoll ? context?.signal : undefined
      })
    } finally {
      this.releaseLongPoll(longPoll)
    }
  }

  // Why: one fence for both transports — the total cap protects short RPCs, the ask
  // sub-cap protects terminal.wait / check --wait from slow reply-blocked asks.
  // Returns the rejection message, or null once the slot is reserved.
  private admitLongPoll(longPoll: LongPollClass | null): string | null {
    if (!longPoll) {
      return null
    }
    if (this.activeLongPolls >= this.longPollCap) {
      return 'long-poll capacity reached; retry with backoff'
    }
    if (longPoll === 'ask' && this.activeAskLongPolls >= this.askLongPollCap) {
      return 'orchestration.ask capacity reached; retry with backoff'
    }
    this.activeLongPolls += 1
    if (longPoll === 'ask') {
      this.activeAskLongPolls += 1
    }
    return null
  }

  private releaseLongPoll(longPoll: LongPollClass | null): void {
    if (!longPoll) {
      return
    }
    this.activeLongPolls = Math.max(0, this.activeLongPolls - 1)
    if (longPoll === 'ask') {
      this.activeAskLongPolls = Math.max(0, this.activeAskLongPolls - 1)
    }
  }

  private parseAndAuth(rawMessage: string): { request: RpcRequest } | { error: RpcResponse } {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      return { error: this.buildError('unknown', 'bad_request', 'Invalid JSON request') }
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      return { error: this.buildError('unknown', 'bad_request', 'Missing request id') }
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return { error: this.buildError(request.id, 'bad_request', 'Missing RPC method') }
    }
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      return { error: this.buildError(request.id, 'unauthorized', 'Missing auth token') }
    }
    if (request.authToken !== this.authToken) {
      return { error: this.buildError(request.id, 'unauthorized', 'Invalid auth token') }
    }

    return { request }
  }

  // Why: WebSocket dispatch is streaming (multiple responses) and auths via per-device tokens, not the shared token.
  private async handleWebSocketMessage(
    rawMessage: string,
    reply: (response: string) => void,
    sendBinary: (response: Uint8Array<ArrayBufferLike>) => boolean | void,
    wsTransport?: WebSocketTransport,
    ws?: WebSocket,
    authenticatedDeviceToken?: string | null,
    authenticatedSocket?: AuthenticatedMobileSocket
  ): Promise<void> {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      reply(JSON.stringify(this.buildError('unknown', 'bad_request', 'Invalid JSON request')))
      return
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      reply(JSON.stringify(this.buildError('unknown', 'bad_request', 'Missing request id')))
      return
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      reply(JSON.stringify(this.buildError(request.id, 'bad_request', 'Missing RPC method')))
      return
    }

    const requestToken =
      typeof (request as Record<string, unknown>).deviceToken === 'string'
        ? ((request as Record<string, unknown>).deviceToken as string)
        : null
    if (authenticatedDeviceToken && requestToken && requestToken !== authenticatedDeviceToken) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Device token mismatch')))
      return
    }
    // Why: E2EE already authenticated the channel; authorize by that bound identity, not a repeated request field.
    const token = authenticatedDeviceToken ?? requestToken
    if (!token) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Missing device token')))
      return
    }
    const device = this.deviceRegistry?.validateToken(token)
    if (!device) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Invalid device token')))
      return
    }
    if (device.scope === 'mobile' && !MOBILE_RPC_METHOD_ALLOWLIST.has(request.method)) {
      reply(
        JSON.stringify(
          this.buildError(
            request.id,
            'forbidden',
            `Method '${request.method}' is not available to mobile clients`
          )
        )
      )
      return
    }

    // Why: bind deviceToken to this socket so ws.on('close') knows which mobile client disconnected.
    if (wsTransport && ws) {
      wsTransport.setClientId(ws, token)
    }

    const longPoll = longPollClassOf(request)
    const rejection = this.admitLongPoll(longPoll)
    if (rejection) {
      reply(JSON.stringify(this.buildError(request.id, 'runtime_busy', rejection)))
      return
    }

    const abortRegistration = ws ? this.registerWebSocketDispatchAbort(ws) : null

    // Why: older pairings may lack scope metadata, so stamp the authenticated scope onto status.get.
    const replyForRequest =
      request.method === 'status.get'
        ? (response: string): void => reply(injectDeviceScope(response, device.scope))
        : reply

    const connectionId = ws ? this.mobileSocketWiring?.getConnectionId(ws) : undefined
    const pairingProvider = this.mobileRelayPairingProvider
    const pairingContext =
      pairingProvider && authenticatedSocket
        ? {
            getEndpoints: (params: PairingGetEndpointsParams) =>
              pairingProvider.getEndpoints(
                {
                  deviceId: authenticatedSocket.device.deviceId,
                  connectionId: authenticatedSocket.connectionId,
                  transport: authenticatedSocket.transport
                },
                params
              ),
            provisionRelay: (params: PairingProvisionRelayParams) =>
              pairingProvider.provisionRelay(
                {
                  deviceId: authenticatedSocket.device.deviceId,
                  connectionId: authenticatedSocket.connectionId,
                  transport: authenticatedSocket.transport
                },
                params
              )
          }
        : undefined
    try {
      await this.dispatcher.dispatchStreaming(request, replyForRequest, {
        connectionId,
        clientId: token,
        pairedDeviceId: device.deviceId,
        // Why: gates the mobile-only payload diet so full-screen web/desktop clients aren't truncated.
        clientKind: device.scope,
        clientCapabilities: authenticatedSocket?.clientCapabilities,
        pairing: pairingContext,
        signal: abortRegistration?.signal,
        sendBinary,
        registerBinaryStreamHandler: (streamId, handler) =>
          this.registerBinaryStreamHandler(connectionId, streamId, handler)
      })
    } finally {
      abortRegistration?.dispose()
      this.releaseLongPoll(longPoll)
    }
  }

  private buildError(id: string, code: string, message: string): RpcResponse {
    return errorResponse(id, { runtimeId: this.runtime.getRuntimeId() }, code, message)
  }

  private writeMetadata(): void {
    const metadata: RuntimeMetadata = {
      runtimeId: this.runtime.getRuntimeId(),
      pid: this.pid,
      transports: this.transports,
      authToken: this.authToken,
      startedAt: this.runtime.getStartedAt()
    }
    writeRuntimeMetadata(this.userDataPath, metadata)
  }
}

/** Why: MUST stay in lockstep with createRuntimeTransportMetadata()'s `o-${pid}-${suffix}.sock` shape (unit-test enforced). */
export const RUNTIME_SOCKET_NAME_REGEX = /^o-(\d+)-[A-Za-z0-9_-]+\.sock$/

export function sweepOrphanedRuntimeSockets(userDataPath: string, ownPid: number): void {
  let entries: string[]
  try {
    entries = readdirSync(userDataPath)
  } catch {
    // Why: first-launch userData may not exist yet; nothing to sweep.
    return
  }
  for (const entry of entries) {
    const match = RUNTIME_SOCKET_NAME_REGEX.exec(entry)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    if (!Number.isFinite(pid)) {
      continue
    }
    // Why: never delete our own socket — a bug here would rmSync one we're about to bind.
    if (pid === ownPid) {
      continue
    }
    try {
      // Why: signal 0 is the POSIX liveness probe (sends nothing); ESRCH = dead pid, EPERM = foreign owner (left alone).
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          rmSync(join(userDataPath, entry), { force: true })
        } catch {
          // Why: best-effort sweep; a later start() or OS reboot cleans any socket we can't unlink.
        }
      }
    }
  }
}

export function createRuntimeTransportMetadata(
  userDataPath: string,
  pid: number,
  platform: NodeJS.Platform,
  runtimeId = 'runtime'
): RuntimeTransportMetadata {
  const endpointSuffix = runtimeId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 4) || 'rt'
  if (platform === 'win32') {
    return {
      kind: 'named-pipe',
      // Why: named pipes lack the chmod hardening of Unix sockets; a per-runtime suffix avoids a stable, guessable endpoint name.
      endpoint: `\\\\.\\pipe\\orca-${pid}-${endpointSuffix}`
    }
  }
  return {
    kind: 'unix',
    endpoint: join(userDataPath, `o-${pid}-${endpointSuffix}.sock`)
  }
}
