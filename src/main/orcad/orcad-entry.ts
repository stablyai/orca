/**
 * `orcad` — the Orca runtime served from Bun, with no Electron.
 *
 * Installs the Node host adapters, constructs the same `OrcaRuntimeService` the
 * desktop uses, installs a PTY controller via `registerHeadlessPtyRuntime`, and
 * serves runtime RPC. See docs/design/node-only-runtime-backend.html.
 *
 * Desktop UI surfaces stay uninstalled: no native notifications, no renderer window. The
 * renderer window is faked as a destroyed one because `registerPtyHandlers` takes a
 * non-null `BrowserWindow`. Browser automation is different — it is installed through
 * the runtime factory, but only when an Electron serve sidecar or an operator-supplied
 * Chromium proves available at startup.
 */
import process from 'node:process'
import { join } from 'node:path'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { setSecretStore, type SecretStore } from '../../shared/secret-store'
import type { ServeReadiness } from '../server/serve-readiness'
import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { startOrcadBrowserProvider } from './orcad-browser-startup'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { recoverOrcadRuntimeTerminals } from './orcad-runtime-terminal-recovery'
import { configureOrcadHostDecommission } from './orcad-host-decommission'
import { parseArgs, type OrcadOptions } from './orcad-launch-options'
export { parseArgs, type OrcadOptions } from './orcad-launch-options'
import { resolveOrcadInstallRoot, resolveOrcadPath, resolveUserDataPath } from './orcad-app-paths'
import {
  describeOrcadBindExposure,
  OrcadBindAddressError,
  resolveOrcadBindHost
} from './orcad-bind-address'
import { acquireOrcadInstanceLock, OrcadInstanceLockError } from './orcad-instance-lock'
import type { OrcadManagedStopRequestContext } from './orcad-managed-stop-request'
import {
  installOrcadProcessShutdown,
  ORCAD_EXIT_CONFIGURATION,
  ORCAD_EXIT_FAILED
} from './orcad-process-shutdown'
export {
  ORCAD_EXIT_OK,
  ORCAD_EXIT_FAILED,
  ORCAD_EXIT_CONFIGURATION,
  ORCAD_SHUTDOWN_DEADLINE_MS
} from './orcad-process-shutdown'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { initializeProfileLifetimeAdmission } from '../ssh/profile-lifetime-admission'

let runOrcadQuitHandlers = (): void => {}

function createNodeAppEnvironment(): AppEnvironment {
  const quitHandlers: (() => void)[] = []
  // The main signal handler awaits runtime and browser teardown before process.exit.
  // Keep will-quit callbacks synchronous, but never let them pre-empt that async barrier.
  runOrcadQuitHandlers = (): void => {
    const errors: unknown[] = []
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, 'orcad_quit_handlers_failed')
    }
  }
  return {
    getPath: resolveOrcadPath,
    getAppPath: () => resolveOrcadInstallRoot(),
    getVersion: () => process.env.ORCA_VERSION ?? '0.0.0-orcad',
    // Why still true: consumers read this as "production build, not a dev checkout" —
    // it gates HTTPS-only skill downloads, the real CLI command name, and shell-PATH
    // hydration. Answering false to satisfy a path resolver would relax a security
    // posture. Layout questions must ask whether the app root is an asar archive
    // instead (see parcel-watcher-entry-path.ts).
    isPackaged: () => true,
    onWillQuit: (handler) => quitHandlers.push(handler),
    exit: (code = 0) => process.exit(code),
    // Why []: there are no Chromium processes on this host to measure.
    getAppMetrics: () => []
  }
}

/**
 * Why not silently plaintext: `isEncryptionAvailable() === false` already makes every
 * caller fall back to unsealed storage, which is a security posture, not a detail.
 * `describeProtectionGap()` gives the reason a client can surface.
 */
function createNodeSecretStore(): SecretStore {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('orcad_secret_sealing_unavailable')
    },
    decryptString: () => {
      throw new Error('orcad_secret_sealing_unavailable')
    },
    describeProtectionGap: () =>
      'This host has no OS keyring, so credentials are stored unencrypted. Pair from a desktop to manage secrets, or install and unlock a keyring.'
  }
}

export function installOrcadHostAdapters(): void {
  setAppEnvironment(createNodeAppEnvironment())
  setSecretStore(createNodeSecretStore())
}

export type OrcadHandle = {
  readiness: ServeReadiness
  managedStop: OrcadManagedStopRequestContext
  stop(): Promise<void>
}

/**
 * Boot the runtime and serve RPC. Resolves once the transport is listening and the
 * readiness payload has been published, mirroring the desktop `--serve` contract byte
 * for byte so the same harnesses can drive either host.
 */
export async function startOrcad(options: OrcadOptions = {}): Promise<OrcadHandle> {
  installOrcadHostAdapters()
  const userDataPath = resolveUserDataPath()
  // Why before anything else touches the root: the profile index, the store and the daemon
  // runtime dir all live under it, and two orcads sharing them corrupt state silently. This
  // is also the last point at which refusing costs nothing.
  const instanceLock = acquireOrcadInstanceLock(userDataPath)
  const lifetime = new OrcadRuntimeLifetime(() => instanceLock.release())
  lifetime.add(() => runOrcadQuitHandlers())
  lifetime.add(() => setRuntimeBrowserCommandsFactory(null))
  try {
    initializeProfileLifetimeAdmission(userDataPath)
    const browserProvider = startOrcadBrowserProvider({ userDataPath })
    lifetime.add(() => browserProvider.stop())
    return await startOrcadRuntime(options, lifetime, instanceLock)
  } catch (error) {
    try {
      await lifetime.stop()
    } catch (cleanupError) {
      console.error('[orcad] startup cleanup failed; instance lock retained:', cleanupError)
    }
    throw error
  }
}

async function startOrcadRuntime(
  options: OrcadOptions,
  lifetime: OrcadRuntimeLifetime,
  instanceLock: ReturnType<typeof acquireOrcadInstanceLock>
): Promise<OrcadHandle> {
  const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
  const { OrcaRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const {
    registerHeadlessPtyRuntime,
    getLocalPtyProvider,
    getSshPtyProvider,
    subscribeLocalPtyProviderChanges
  } = await import('../ipc/pty')
  const { getAppEnvironment } = await import('../../shared/app-environment')
  const { resolveAdvertisedPairingEndpoint } = await import('../runtime/pairing-endpoint')
  const { ServeReadinessPublisher } = await import('../server/serve-readiness')
  const { Store } = await import('../persistence/loading-store/store')
  const { ensureActiveOrcaProfile, initOrcaProfilePaths } =
    await import('../orca-profiles/profile-index-store')
  const { initSshHostKeyStoreFile } = await import('../ssh/ssh-host-key-store')
  const { stopOrcadDaemon } = await import('./orcad-daemon-supervision')
  const { startOrcadProfileDaemon, captureOrcadManagedStopContext } =
    await import('./orcad-profile-daemon-startup')
  const { daemonOwnsFreshPersistentPtys } = await import('../daemon/daemon-init')
  const { collectOrcadHealth } = await import('./orcad-health')
  const { agentHookServer } = await import('../agent-hooks/server')
  const { isAgentStatusHooksEnabled } = await import('../agent-hooks/managed-agent-hook-controls')
  const { installHookStatusSessionTabsRepublish } =
    await import('../agent-hooks/hook-status-session-tabs-republish')
  const { AgentStatusObservedPaneIdentities, AgentStatusObservedPaneIdentityCapture } =
    await import('../runtime/agent-status-observed-pane-identity')
  const { DesktopPushService } = await import('../runtime/push/desktop-push-service')
  const { resolvePushGatewayOrigin } = await import('../runtime/push/push-gateway-origin')

  lifetime.add(() => agentHookServer.stop())
  const { configureOrcadDecommission } = await import('./orcad-decommission')
  const { decommissionOrcadDaemonIfIdle } = await import('./orcad-daemon-supervision')
  const {
    RuntimePtyOwnershipTransferReadOnlySource,
    createReconciledRuntimePtyOwnershipTransferReadOnlySource
  } = await import('../providers/runtime-pty-ownership-transfer-read-only-source')

  const runtimeUserDataPath = getAppEnvironment().getPath('userData')
  initOrcaProfilePaths()
  const profile = ensureActiveOrcaProfile(runtimeUserDataPath)
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const observedStatusCapture = new AgentStatusObservedPaneIdentityCapture(observedPaneIdentities)
  // Why a real Store: without one every persistence-backed RPC throws `runtime_unavailable`
  // and the read paths that use `this.store?.x ?? []` quietly answer "empty" instead —
  // a server that pairs and lists nothing looks healthy and is not.
  // Why: orcad IS the runtime authority — loading as 'desktop' would classify its
  // own runtime-scheduled automations as ambiguous mirrors and orphan them.
  const store = new Store({ dataFile: profile.dataFile, storageAuthority: 'runtime' })
  // Why: every SSH connect consults this sidecar. Left unbound it reports nothing trusted,
  // which is safe but silently discards accept records on every launch.
  initSshHostKeyStoreFile(profile.dataFile)

  lifetime.add(
    agentHookServer.subscribeEnrichedStatus((enriched) => observedStatusCapture.observe(enriched))
  )
  if (isAgentStatusHooksEnabled(store.getSettings())) {
    await agentHookServer.start({ env: 'production', userDataPath: runtimeUserDataPath })
  }

  // Why before the runtime and the PTY handlers: `setLocalPtyProvider` installs the daemon
  // adapter as THE local provider, and the registry's contract is that it lands before
  // registerPtyHandlers so the IPC layer routes through the daemon from the first call.
  // Disconnect only: the detached daemon and its terminals must survive runtime teardown.
  lifetime.add(stopOrcadDaemon)
  const runtimeId = await startOrcadProfileDaemon(profile.profileDirectory)
  const managedStop = captureOrcadManagedStopContext(runtimeId, profile, instanceLock)
  let localPtyOwnershipTransferReadOnlySource: InstanceType<
    typeof RuntimePtyOwnershipTransferReadOnlySource
  > | null = null
  let unsubscribeLocalPtyOwnershipProviderChanges = (): void => {}
  lifetime.add(() => localPtyOwnershipTransferReadOnlySource?.dispose())
  lifetime.add(() => unsubscribeLocalPtyOwnershipProviderChanges())
  try {
    const binding = await createReconciledRuntimePtyOwnershipTransferReadOnlySource({
      stateDirectory: join(profile.profileDirectory, 'pty-ownership-transfer-source'),
      runtimeId,
      onError: (error) => console.error('[orcad] local PTY provider reconciliation failed:', error),
      mutationEnabled: () => isPtyOwnershipTransferMutationEnabled(),
      authorizeMutationRequest: (method, request, authBinding) =>
        localPtyOwnershipTransferReadOnlySource?.authorizeMutationRequest(
          method,
          request,
          authBinding
        ) ?? false,
      getProvider: getLocalPtyProvider,
      subscribe: subscribeLocalPtyProviderChanges
    })
    localPtyOwnershipTransferReadOnlySource = binding.source
    unsubscribeLocalPtyOwnershipProviderChanges = binding.unsubscribe
  } catch (error) {
    console.error('[orcad] local PTY ownership source state is unavailable:', error)
  }

  const runtime = new OrcaRuntimeService(store, undefined, {
    runtimeId,
    // Why lazy: a daemon swap replaces the provider after construction, so an eager
    // reference would freeze the pre-daemon one.
    getLocalProvider: () => getLocalPtyProvider(),
    getLocalPtyOwnershipTransferReadOnlySource: () => localPtyOwnershipTransferReadOnlySource,
    getLocalPtyOwnershipTransferSource: () =>
      localPtyOwnershipTransferReadOnlySource?.getMutationSource() ?? null,
    ptyOwnershipTransferMutationEnabled: () => isPtyOwnershipTransferMutationEnabled(),
    // Why: destructive worktree removal refuses to run without a provider to stop
    // processes through — correctly, since it cannot otherwise verify the tree is idle.
    getSshProvider: (connectionId) => getSshPtyProvider(connectionId),
    // Why the daemon predicate and not a constant: orcad now spawns the terminal daemon, so
    // its PTYs DO survive an orcad restart — but only while a daemon that owns fresh
    // sessions is installed. A failed or degraded launch has to answer false, and this reads
    // that live rather than snapshotting it at construction.
    canRecoverPersistentLocalPtys: () => daemonOwnsFreshPersistentPtys(),
    // Why 'blocked': `'openable'` means a desktop window can be opened here, which is
    // what powers serve→desktop promotion. A Node host can never do that, and the
    // constructor's default would advertise it.
    getDesktopWindowStatus: () => 'blocked',
    // Why here too and not only on the desktop: main's OSC parse is the only producer for a
    // PTY agent on this host, and the store is the only place `worktree.ps` and the mobile
    // projection read from — unwired, orcad lists no PTY agents at all.
    onTerminalAgentStatus: (event) => agentHookServer.ingestTerminalStatus(event),
    // Why here too and not only on the desktop: orcad serves `worktree.ps` and `agentSession.*`,
    // so without these a headless host publishes its structured chats nowhere and lists no agents.
    getAgentStatusSnapshot: () =>
      agentHookServer.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    getAgentProviderSessionSnapshot: () => agentHookServer.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) =>
      agentHookServer.getStatusSnapshotForPane(paneKey),
    // Why captured rather than resolved at read: the fleet snapshot remints cached rows on every
    // read, so a row observed under one process otherwise acquires whatever process owns the pane now.
    readObservedAgentStatusPaneIdentity: (paneKey) => observedPaneIdentities.read(paneKey),
    structuredAgentStatusSink: {
      publish: (summary) => agentHookServer.ingestStructuredStatus(summary),
      forget: (sessionId) => agentHookServer.dropStructuredStatus(sessionId)
    },
    reconcileAgentStatusForEndedProcess: (paneKeys) =>
      agentHookServer.reconcileEndedProcessForPaneKeys(paneKeys),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(store.getSettings()) ? agentHookServer.buildPtyEnv() : {}
  })
  // Install the durable destination sink before the headless RPC endpoint accepts SSH clients.
  runtime.installPtyOwnershipTransferDestinationOutputBridge(
    isPtyOwnershipTransferMutationEnabled() ? { catalogPublicationVersion: 1 } : {}
  )

  // Why here too and not only on the desktop: nothing else republishes `session.tabs` when a
  // pane's status row changes, and orcad's whole job is serving paired clients.
  lifetime.add(installHookStatusSessionTabsRepublish(agentHookServer, () => runtime))

  // Why the headless entry point rather than registerPtyHandlers directly: this is the
  // same call `--serve` makes, and it threads the store through. Without the store the
  // handlers install fine and every terminal.create then fails at persistence time.
  //
  // Codex-home and Claude-auth preparation are left unset: both are desktop account
  // flows. A launch that needs one fails with its own message rather than silently
  // spawning an unauthenticated agent.
  await registerHeadlessPtyRuntime(runtime, undefined, () => store.getSettings(), undefined, store)

  // Why: same post-registration reconciliation `--serve` performs. Skipping it leaves
  // restored orchestration rows claiming an authority this host never took over.
  // Why before the RPC server binds: a client host attaching first would find no pages to recover.
  runtime.rehydrateClientHostedBrowserPages()
  await recoverOrcadRuntimeTerminals(runtime, lifetime, getLocalPtyProvider)

  // Recovery binds terminal and dispatch identities; only now can startup observations be fenced.
  observedStatusCapture.attach(runtime)

  const bindHost = resolveOrcadBindHost(options.bind)
  const rpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: runtimeUserDataPath,
    enableWebSocket: true,
    // Why pinned and not `exposeNetworkByDefault`: an unattended host's exposure must be
    // exactly what the operator asked for, on every launch. The default path widens itself
    // once a device has connected, so a loopback deployment would silently go wide one
    // restart after its first client paired.
    pinnedBindHost: bindHost,
    ...(options.port !== undefined
      ? { wsPort: options.port, preferPinnedWsPort: true, requirePinnedWsPort: true }
      : {})
  })
  lifetime.add(() => rpc.stop())
  await rpc.start()
  const pushService = DesktopPushService.create({
    runtime,
    runtimeRpc: rpc,
    gatewayUrl: resolvePushGatewayOrigin(process.env, getAppEnvironment().isPackaged())
  })
  lifetime.add(() => pushService?.stop())
  pushService?.start()
  console.error(`[orcad] ${describeOrcadBindExposure(bindHost)}`)

  const boundEndpoint = rpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  const offer = options.noPairing
    ? ({
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      } as const)
    : rpc.createPairingOffer({
        address: options.pairingAddress,
        name: `CLI ${new Date().toLocaleDateString()}`,
        scope: 'runtime'
      })

  const readiness: ServeReadiness = {
    runtimeId: runtime.getRuntimeId(),
    boundEndpoint,
    advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
    // Why 'settled': the WSL CLI reconciliation barrier is a desktop-launch concern.
    // orcad never runs it, so there is no pending repair a client could race.
    managedWslCliReconciliation: 'settled',
    pairing: offer.available
      ? {
          available: true,
          url: offer.pairingUrl,
          endpoint: offer.endpoint,
          deviceId: offer.deviceId,
          webClientUrl: offer.webClientUrl,
          scope: 'runtime',
          qr: null
        }
      : offer,
    // Why in the readiness payload: this is the one message a supervisor and a deploy
    // transaction both read, and a green orcad with a dead daemon is exactly the
    // looks-healthy-but-useless state they must not activate.
    health: await collectOrcadHealth(getAppEnvironment().getVersion())
  }

  configureOrcadHostDecommission(runtime, decommissionOrcadDaemonIfIdle, ...managedStop)
  lifetime.add(() => configureOrcadDecommission(null))
  await new ServeReadinessPublisher().publish(readiness, {
    mode: options.json ? 'json' : 'human'
  })

  return {
    readiness,
    managedStop: {
      version: getAppEnvironment().getVersion(),
      identity: managedStop[0],
      instance: managedStop[1]
    },
    stop: () => lifetime.stop()
  }
}

/**
 * Exit codes a supervisor can act on. Closed set — see docs/reference/orcad-operations.md.
 *
 * `ORCAD_EXIT_CONFIGURATION` is the load-bearing one: a data root owned by someone else, or
 * held by another orcad, is not fixed by restarting. Restarting on it is the crash-loop the
 * supervision contract has to prevent, so systemd's `RestartPreventExitStatus` needs a code
 * that means "do not retry" and nothing else does.
 */
export function resolveOrcadExitCode(error: unknown): number {
  return error instanceof OrcadInstanceLockError || error instanceof OrcadBindAddressError
    ? ORCAD_EXIT_CONFIGURATION
    : ORCAD_EXIT_FAILED
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const handle = await startOrcad(parseArgs(argv))
  installOrcadProcessShutdown(handle, resolveOrcadInstallRoot(), handle.managedStop)
}
