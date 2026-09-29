/**
 * `orcad` — the Orca runtime served without Electron.
 *
 * Installs the Node host adapters, constructs the same `OrcaRuntimeService` the
 * desktop uses, installs a PTY controller via `registerHeadlessPtyRuntime`, and
 * serves runtime RPC. See docs/design/node-only-runtime-backend.html.
 *
 * Desktop UI surfaces stay uninstalled: no native notifications or renderer delivery.
 * Browser automation is installed through
 * the runtime factory, but only when an Electron serve sidecar or an operator-supplied
 * Chromium proves available at startup.
 */
import process from 'node:process'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { setSecretStore, type SecretStore } from '../../shared/secret-store'
import type { ServeReadiness } from '../server/serve-readiness'
import { resolveOrcadInstallRoot, resolveOrcadPath, resolveUserDataPath } from './orcad-app-paths'
import { describeOrcadBindExposure, resolveOrcadBindHost } from './orcad-bind-address'
import {
  flushOrcadProfileStoreForShutdown,
  installOrcadShutdownSignals,
  startOrcadWithHost
} from './orcad-lifecycle'
import { parseArgs } from './orcad-command-arguments'
import {
  changedAiVaultSearchSettings,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'

export { parseArgs }

let runOrcadQuitHandlers = (): void => {}

function createNodeAppEnvironment(): AppEnvironment {
  const quitHandlers: (() => void)[] = []
  // The main signal handler awaits runtime and browser teardown before process.exit.
  // Keep will-quit callbacks synchronous, but never let them pre-empt that async barrier.
  runOrcadQuitHandlers = (): void => {
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        console.error('[orcad] shutdown handler failed:', error)
      }
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

export type OrcadOptions = {
  port?: number
  json?: boolean
  noPairing?: boolean
  pairingAddress?: string
  /** Literal IP to bind. Defaults to loopback; see orcad-bind-address.ts. */
  bind?: string
}

export type OrcadHandle = {
  readiness: ServeReadiness
  stop(): Promise<void>
}

/**
 * Boot the runtime and serve RPC. Resolves once the transport is listening and the
 * readiness payload has been published, mirroring the desktop `--serve` contract byte
 * for byte so the same harnesses can drive either host.
 */
export async function startOrcad(options: OrcadOptions = {}): Promise<OrcadHandle> {
  installOrcadHostAdapters()
  return startOrcadWithHost(
    resolveUserDataPath(),
    (registerCleanup) => startOrcadRuntime(options, registerCleanup),
    () => runOrcadQuitHandlers()
  )
}

async function startOrcadRuntime(
  options: OrcadOptions,
  registerCleanup: (cleanup: () => Promise<void>) => void
): Promise<Pick<OrcadHandle, 'readiness'>> {
  const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
  const { OrcaRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const { registerHeadlessPtyRuntime, getLocalPtyProvider, getSshPtyProvider } =
    await import('../ipc/pty')
  const { getAppEnvironment } = await import('../../shared/app-environment')
  const { resolveAdvertisedPairingEndpoint } = await import('../runtime/pairing-endpoint')
  const { ServeReadinessPublisher } = await import('../server/serve-readiness')
  const { createOrcadProfileStateStartup } = await import('./orcad-profile-state-startup')
  const { startOrcadDaemon, stopOrcadDaemon } = await import('./orcad-daemon-supervision')
  const { daemonOwnsFreshPersistentPtys } = await import('../daemon/daemon-init')
  const { collectOrcadHealth } = await import('./orcad-health')
  // Why importable here: the singleton's module tree never reaches Electron, and orcad supplies
  // its persistence and endpoint paths explicitly below.
  const { agentHookServer } = await import('../agent-hooks/server')
  const { isAgentStatusHooksEnabled } = await import('../agent-hooks/managed-agent-hook-controls')
  const { installHookStatusSessionTabsRepublish } =
    await import('../agent-hooks/hook-status-session-tabs-republish')
  const { AgentStatusObservedPaneIdentities, AgentStatusObservedPaneIdentityCapture } =
    await import('../runtime/agent-status-observed-pane-identity')

  let rpc: InstanceType<typeof OrcaRuntimeRpcServer> | null = null
  let profileStoreForShutdown:
    | { flushFinalOrThrowAsync(): Promise<void>; freezeWritesAsync(): Promise<void> }
    | undefined
  let uninstallHookStatusRepublish = (): void => {}
  let uninstallObservedStatusIdentity = (): void => {}
  registerCleanup(async () => {
    try {
      await rpc?.stop()
    } finally {
      try {
        // Stop accepting RPC writes before the final persistence barrier. A SQLite-backed
        // orcad has no JSON mirror to absorb a debounced write after SIGTERM.
        if (profileStoreForShutdown) {
          await flushOrcadProfileStoreForShutdown(profileStoreForShutdown)
        }
      } finally {
        try {
          // Why disconnect and not shut down: the daemon must outlive this process, or an
          // orcad restart goes back to killing every running terminal.
          await stopOrcadDaemon()
        } finally {
          uninstallObservedStatusIdentity()
          uninstallHookStatusRepublish()
          agentHookServer.stop()
        }
      }
    }
  })
  const { DesktopPushService } = await import('../runtime/push/desktop-push-service')
  const { resolvePushGatewayOrigin } = await import('../runtime/push/push-gateway-origin')

  const runtimeUserDataPath = getAppEnvironment().getPath('userData')
  const { store: profileStore, authority: profileStateAuthority } =
    await createOrcadProfileStateStartup(runtimeUserDataPath)
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const observedStatusCapture = new AgentStatusObservedPaneIdentityCapture(observedPaneIdentities)
  // Why a real Store: without one every persistence-backed RPC throws `runtime_unavailable`
  // and the read paths that use `this.store?.x ?? []` quietly answer "empty" instead —
  // a server that pairs and lists nothing looks healthy and is not.
  // Why: orcad IS the runtime authority — loading as 'desktop' would classify its
  // own runtime-scheduled automations as ambiguous mirrors and orphan them.
  profileStoreForShutdown = profileStore
  // Why: every SSH connect consults this sidecar. Left unbound it reports nothing trusted,
  // which is safe but silently discards accept records on every launch.

  uninstallObservedStatusIdentity = agentHookServer.subscribeEnrichedStatus((enriched) =>
    observedStatusCapture.observe(enriched)
  )
  if (isAgentStatusHooksEnabled(profileStore.getSettings())) {
    await agentHookServer.start({ env: 'production', userDataPath: runtimeUserDataPath })
  }

  // Why before the runtime and the PTY handlers: `setLocalPtyProvider` installs the daemon
  // adapter as THE local provider, and the registry's contract is that it lands before
  // registerPtyHandlers so the IPC layer routes through the daemon from the first call.
  await startOrcadDaemon()

  // Why a holder and not a direct reference: the index is installed after the runtime is
  // constructed, and the deps hook is only ever called later, from an RPC.
  let sessionSearch: { apply(settings: AiVaultSearchSettings): void; dispose(): void } | null = null

  const runtime = new OrcaRuntimeService(profileStore, undefined, {
    // Why lazy: a daemon swap replaces the provider after construction, so an eager
    // reference would freeze the pre-daemon one.
    getLocalProvider: () => getLocalPtyProvider(),
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
      publish: (summary, subject) => agentHookServer.ingestStructuredStatus(summary, subject),
      forget: (subject) => agentHookServer.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        agentHookServer.ingestStructuredChildWork(subject, evidence, provider)
    },
    reconcileAgentStatusForEndedProcess: (paneKeys) =>
      agentHookServer.reconcileEndedProcessForPaneKeys(paneKeys),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(profileStore.getSettings()) ? agentHookServer.buildPtyEnv() : {},
    // Why the dedupe here and not in the instance: `apply` closes and reconstructs
    // unconditionally, so an unchanged value would restart a healthy index.
    applySessionSearchSettings: (before, after) => {
      const next = changedAiVaultSearchSettings(before, after)
      if (next) {
        sessionSearch?.apply(next)
      }
    }
  })

  const { installOrcadSessionSearchService } = await import('./orcad-session-search')
  sessionSearch = await installOrcadSessionSearchService({
    userDataPath: runtimeUserDataPath,
    getSettings: () => profileStore.getSettings()
  })
  getAppEnvironment().onWillQuit(() => sessionSearch?.dispose())

  // Why here too and not only on the desktop: nothing else republishes `session.tabs` when a
  // pane's status row changes, and orcad's whole job is serving paired clients.
  uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => runtime
  )

  // Why the headless entry point rather than registerPtyHandlers directly: this is the
  // same call `--serve` makes, and it threads the store through. Without the store the
  // handlers install fine and every terminal.create then fails at persistence time.
  //
  // Codex-home and Claude-auth preparation are left unset: both are desktop account
  // flows. A launch that needs one fails with its own message rather than silently
  // spawning an unauthenticated agent.
  await registerHeadlessPtyRuntime(
    runtime,
    undefined,
    () => profileStore.getSettings(),
    undefined,
    profileStore
  )

  // Why: same post-registration reconciliation `--serve` performs. Skipping it leaves
  // restored orchestration rows claiming an authority this host never took over.
  // Why before the RPC server binds: a client host attaching first would find no pages to recover.
  runtime.rehydrateClientHostedBrowserPages()

  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()

  // Recovery binds terminal and dispatch identities; only now can startup observations be fenced.
  observedStatusCapture.attach(runtime)

  const bindHost = resolveOrcadBindHost(options.bind)
  rpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: runtimeUserDataPath,
    enableWebSocket: true,
    // Why pinned and not `exposeNetworkByDefault`: an unattended host's exposure must be
    // exactly what the operator asked for, on every launch. The default path widens itself
    // once a device has connected, so a loopback deployment would silently go wide one
    // restart after its first client paired.
    pinnedBindHost: bindHost,
    ...(options.port !== undefined ? { wsPort: options.port, preferPinnedWsPort: true } : {})
  })
  await rpc.start()
  const pushService = DesktopPushService.create({
    runtime,
    runtimeRpc: rpc,
    gatewayUrl: resolvePushGatewayOrigin(process.env, getAppEnvironment().isPackaged())
  })
  pushService?.start()
  getAppEnvironment().onWillQuit(() => pushService?.stop())
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
    health: await collectOrcadHealth(getAppEnvironment().getVersion(), profileStateAuthority)
  }

  await new ServeReadinessPublisher().publish(readiness, {
    mode: options.json ? 'json' : 'human'
  })

  return { readiness }
}

/**
 * Exit codes a supervisor can act on. Closed set — see docs/reference/orcad-operations.md.
 *
 * `ORCAD_EXIT_CONFIGURATION` is the load-bearing one: a data root owned by someone else, or
 * held by another orcad, is not fixed by restarting. Restarting on it is the crash-loop the
 * supervision contract has to prevent, so systemd's `RestartPreventExitStatus` needs a code
 * that means "do not retry" and nothing else does.
 */
export {
  ORCAD_EXIT_OK,
  ORCAD_EXIT_FAILED,
  ORCAD_EXIT_CONFIGURATION,
  resolveOrcadExitCode
} from './orcad-exit-code'

/** Bounded so a wedged transport cannot hold a supervisor's stop past its own deadline. */
export { ORCAD_SHUTDOWN_DEADLINE_MS } from './orcad-lifecycle'

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const startup = startOrcad(parseArgs(argv))
  installOrcadShutdownSignals(async () => (await startup).stop())
  await startup
}
