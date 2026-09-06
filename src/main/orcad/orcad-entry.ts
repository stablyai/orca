/**
 * `orcad` — the Orca runtime served from plain Node, with no Electron.
 *
 * Installs the Node host adapters, constructs the same `OrcaRuntimeService` the
 * desktop uses, installs a PTY controller via `registerHeadlessPtyRuntime`, and
 * serves runtime RPC. See docs/design/node-only-runtime-backend.html.
 *
 * Desktop UI surfaces stay uninstalled: no notifications, no renderer window. The
 * renderer window is faked as a destroyed one because `registerPtyHandlers` takes a
 * non-null `BrowserWindow`. Browser automation is different — it is installed through
 * the runtime factory, but only when an Electron serve sidecar or an operator-supplied
 * Chromium proves available at startup.
 */
import process from 'node:process'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { setSecretStore, type SecretStore } from '../../shared/secret-store'
import type { ServeReadiness } from '../server/serve-readiness'
import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { resolveOrcadBrowserProvider, type OrcadBrowserProvider } from './orcad-browser-provider'
import { resolveOrcadInstallRoot, resolveOrcadPath, resolveUserDataPath } from './orcad-app-paths'
import {
  describeOrcadBindExposure,
  OrcadBindAddressError,
  resolveOrcadBindHost
} from './orcad-bind-address'
import {
  acquireOrcadInstanceLock,
  OrcadInstanceLockError,
  type OrcadInstanceLock
} from './orcad-instance-lock'

let runOrcadQuitHandlers = (): void => {}

// Why module scope, like the quit handlers above: the server is started deep inside
// `startOrcadRuntime`, and the launch failure path that must undo it runs in `startOrcad`,
// which never imports it.
let stopOrcadAgentHookServer = (): void => {}

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
  const userDataPath = resolveUserDataPath()
  // Why before anything else touches the root: the profile index, the store and the daemon
  // runtime dir all live under it, and two orcads sharing them corrupt state silently. This
  // is also the last point at which refusing costs nothing.
  const instanceLock = acquireOrcadInstanceLock(userDataPath)
  const browserProvider = await resolveOrcadBrowserProvider({ userDataPath })
  setRuntimeBrowserCommandsFactory(browserProvider?.factory ?? null, {
    headless: browserProvider !== null,
    ...(browserProvider ? { isAvailable: () => browserProvider.isAvailable() } : {})
  })
  try {
    return await startOrcadRuntime(options, browserProvider, instanceLock)
  } catch (error) {
    stopOrcadAgentHookServer()
    try {
      await browserProvider?.stop()
    } catch (stopError) {
      // Why swallowed rather than rethrown: `error` is why the host failed to come up and is
      // the one an operator can act on. Letting a teardown rejection replace it reports the
      // symptom and discards the cause — and would skip the lock release below, so a launch
      // that failed once would then refuse to be retried.
      console.error(
        `[orcad] browser provider teardown failed during launch cleanup: ${
          stopError instanceof Error ? stopError.message : String(stopError)
        }`
      )
    }
    setRuntimeBrowserCommandsFactory(null)
    runOrcadQuitHandlers()
    instanceLock.release()
    throw error
  }
}

async function startOrcadRuntime(
  options: OrcadOptions,
  browserProvider: OrcadBrowserProvider | null,
  instanceLock: OrcadInstanceLock
): Promise<OrcadHandle> {
  const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
  const { OrcaRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const { registerHeadlessPtyRuntime, getLocalPtyProvider, getSshPtyProvider } =
    await import('../ipc/pty')
  const { getAppEnvironment } = await import('../../shared/app-environment')
  const { resolveAdvertisedPairingEndpoint } = await import('../runtime/pairing-endpoint')
  const { ServeReadinessPublisher } = await import('../server/serve-readiness')
  const { Store } = await import('../persistence/loading-store/store')
  const { ensureActiveOrcaProfile, initOrcaProfilePaths } =
    await import('../orca-profiles/profile-index-store')
  const { initSshHostKeyStoreFile } = await import('../ssh/ssh-host-key-store')
  const { startOrcadDaemon, stopOrcadDaemon } = await import('./orcad-daemon-supervision')
  const { agentHookServer } = await import('../agent-hooks/server')
  const { isAgentStatusHooksEnabled } = await import('../agent-hooks/managed-agent-hook-controls')
  const { daemonOwnsFreshPersistentPtys } = await import('../daemon/daemon-init')
  const { collectOrcadHealth } = await import('./orcad-health')

  const runtimeUserDataPath = getAppEnvironment().getPath('userData')
  initOrcaProfilePaths()
  const profile = ensureActiveOrcaProfile(runtimeUserDataPath)
  // Why a real Store: without one every persistence-backed RPC throws `runtime_unavailable`
  // and the read paths that use `this.store?.x ?? []` quietly answer "empty" instead —
  // a server that pairs and lists nothing looks healthy and is not.
  // Why: orcad IS the runtime authority — loading as 'desktop' would classify its
  // own runtime-scheduled automations as ambiguous mirrors and orphan them.
  const store = new Store({ dataFile: profile.dataFile, storageAuthority: 'runtime' })
  // Why: every SSH connect consults this sidecar. Left unbound it reports nothing trusted,
  // which is safe but silently discards accept records on every launch.
  initSshHostKeyStoreFile(profile.dataFile)

  // Why before the daemon: `host-env/assembly.ts` folds `agentHookServer.buildPtyEnv()` into
  // every PTY's environment from LIVE server state, and `buildPtyEnv()` returns {} while the
  // port is 0. A terminal spawned before this — including one the daemon hands back on
  // adoption — is frozen with no hook coordinates, so its agent never reports a session and
  // the chat view has no transcript to render. The spawn path itself needs no change; it was
  // already reading these.
  //
  // Why `userDataPath` is not optional: ORCA_AGENT_HOOK_ENDPOINT is set only when the endpoint
  // file was written, and it is written only when start() received this path. The hook script
  // returns at its first line on that exact variable, so omitting it yields four of the five
  // vars and a hook that still does nothing — the same symptom, harder to find twice. The file
  // matters more here than on the desktop: start() regenerates token and port every launch,
  // while orcad's daemon deliberately outlives the runtime, so a surviving PTY carries stale
  // coordinates that the hook repairs only by sourcing this file at invocation time.
  //
  // No endpointNamespace: that is for parallel dev worktrees, and namespacing would break the
  // endpoint file's stability across exactly the restarts this host is built to survive.
  //
  // Fail open, matching `--serve`: hook callbacks are enrichment, so a loopback bind failure
  // must not refuse a host whose terminals otherwise work.
  if (isAgentStatusHooksEnabled(store.getSettings())) {
    try {
      await agentHookServer.start({ env: 'production', userDataPath: runtimeUserDataPath })
      // Why arm it here and not on the way out: a later startup step throwing leaves the
      // listener bound, and start() returns early while `this.server` is set — so the next
      // attempt in the same process would silently reuse this one's token and endpoint file.
      stopOrcadAgentHookServer = () => agentHookServer.stop()
    } catch (error) {
      console.error(
        `[orcad] agent hook server failed to start; agent chat will not render: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  // Why before the runtime and the PTY handlers: `setLocalPtyProvider` installs the daemon
  // adapter as THE local provider, and the registry's contract is that it lands before
  // registerPtyHandlers so the IPC layer routes through the daemon from the first call.
  await startOrcadDaemon()

  const runtime = new OrcaRuntimeService(store, undefined, {
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
    // Why these seven as well as start(): the server above is only the write path. Unwired,
    // the rows it collects reach nothing — `getHookRowsForPane` answers [] for every pane so
    // published tabs carry no `providerSession.transcriptPath` (the address native chat
    // resolves a transcript by), and `hasProviderSessionObservationSource()` answers false so
    // structured Claude resume refuses with "could not prove its fresh provider session".
    // Same delegations the desktop host makes; ungated for the same reason it is — a server
    // that never started answers empty, which is the same answer a second gate would give.
    onTerminalAgentStatus: (event) => agentHookServer.ingestTerminalStatus(event),
    // Why filtered: resume-identity rows are not running agents and must not read as live.
    getAgentStatusSnapshot: () =>
      agentHookServer.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    // Why unfiltered here: those same rows are what carries the provider session.
    getAgentProviderSessionSnapshot: () => agentHookServer.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) =>
      agentHookServer.getStatusSnapshotForPane(paneKey),
    attestAgentHookCompatibilityAuthority: (candidate) =>
      agentHookServer.attestCompatibilityAuthority(candidate),
    // Why paired with attest: a pane whose launch identity is torn down must stop attesting,
    // or its evidence survives to vouch for a later claim on the same key.
    retireAgentHookCompatibilityAuthority: (paneKey) =>
      agentHookServer.retirePaneAuthority(paneKey),
    reconcileAgentStatusForEndedProcess: (paneKeys) => {
      agentHookServer.reconcileEndedProcessForPaneKeys(paneKeys)
    }
    // No buildAgentHookPtyEnv: `host-env/assembly.ts` reads the same singleton directly, so
    // wiring it here would add a second source for the env this host already gets.
  })

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

  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()

  // Why: nothing publishes a renderer graph here, so `graphStatus` would stay 'unavailable'
  // forever and every RPC gated on a ready graph would fail — `captureReadyGraphEpoch()` is
  // the FIRST statement of runCreateMobileSessionTerminal, so terminal creation returns
  // `runtime_unavailable` before it reaches any PTY code, and the tab inventory's
  // `while (true)` waits on an epoch that can never be established and never returns at all.
  // `--serve` publishes the same empty graph for the same reason (index.ts). Both gates open
  // from this one call: it adopts the headless id as authoritative, marks the graph ready,
  // and publishes the tab inventory.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

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
    ...(options.port !== undefined ? { wsPort: options.port, preferPinnedWsPort: true } : {})
  })
  await rpc.start()
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

  await new ServeReadinessPublisher().publish(readiness, {
    mode: options.json ? 'json' : 'human'
  })

  return {
    readiness,
    stop: async () => {
      try {
        await rpc.stop()
      } finally {
        // Why nested and not one flat sequence: every step here is independent teardown, and
        // both awaits genuinely reject — `disconnectDaemon()` fans out over adapters with
        // `Promise.all` and awaits a checkpoint write, and the browser provider's stop() ends
        // in `rm()`, whose `force` forgives only ENOENT. Flat, the first rejection skips every
        // later step, and the step furthest down is `instanceLock.release()`: a leaked lock
        // file makes the NEXT launch refuse to start, so one bad shutdown costs the host until
        // someone deletes it by hand.
        //
        // What nesting buys is that every step RUNS — not that the first failure is the one
        // reported. A throw from a `finally` replaces the in-flight exception, so if the daemon
        // and the browser provider both reject the caller sees the browser's. That is the right
        // trade here: the lock is released either way, and a lost second error costs a log line
        // where a skipped release costs the next launch.
        try {
          // Why disconnect and not shut down: the daemon must outlive this process, or an
          // orcad restart goes back to killing every running terminal. See
          // orcad-daemon-supervision.ts.
          await stopOrcadDaemon()
        } finally {
          // Why no unlink of the endpoint file: stop() leaves it deliberately — a stale file
          // matches the hook's fail-open behaviour and avoids a TOCTOU race with a concurrent Orca.
          agentHookServer.stop()
          try {
            await browserProvider?.stop()
          } finally {
            setRuntimeBrowserCommandsFactory(null)
            runOrcadQuitHandlers()
            instanceLock.release()
          }
        }
      }
    }
  }
}

export function parseArgs(argv: string[]): OrcadOptions {
  const options: OrcadOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') {
      const raw = argv[i + 1]
      const port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`--port expects an integer 0-65535, got ${raw ?? "''"}`)
      }
      options.port = port
      i += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--no-pairing') {
      options.noPairing = true
    } else if (arg === '--bind') {
      const value = argv[i + 1]
      if (value === undefined) {
        throw new Error('--bind expects a value')
      }
      options.bind = value
      i += 1
    } else if (arg === '--pairing-address') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('--pairing-address expects a value')
      }
      options.pairingAddress = value
      i += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * Exit codes a supervisor can act on. Closed set — see docs/reference/orcad-operations.md.
 *
 * `ORCAD_EXIT_CONFIGURATION` is the load-bearing one: a data root owned by someone else, or
 * held by another orcad, is not fixed by restarting. Restarting on it is the crash-loop the
 * supervision contract has to prevent, so systemd's `RestartPreventExitStatus` needs a code
 * that means "do not retry" and nothing else does.
 */
export const ORCAD_EXIT_OK = 0
export const ORCAD_EXIT_FAILED = 1
export const ORCAD_EXIT_CONFIGURATION = 78

/** Bounded so a wedged transport cannot hold a supervisor's stop past its own deadline. */
export const ORCAD_SHUTDOWN_DEADLINE_MS = 15_000

export function resolveOrcadExitCode(error: unknown): number {
  return error instanceof OrcadInstanceLockError || error instanceof OrcadBindAddressError
    ? ORCAD_EXIT_CONFIGURATION
    : ORCAD_EXIT_FAILED
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const handle = await startOrcad(parseArgs(argv))
  let stopping = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      // Why escalate rather than ignore: a supervisor's second signal means the first
      // deadline elapsed. Continuing to wait silently is what makes a stop hang until
      // SIGKILL, which is the one teardown that skips the daemon handoff entirely.
      console.error(`orcad: second ${signal} during shutdown — exiting immediately`)
      process.exit(ORCAD_EXIT_FAILED)
    }
    stopping = true
    // Why a self-imposed deadline as well: the supervisor's SIGKILL leaves no exit code and
    // no log line. Exiting ourselves keeps the failure attributable.
    const deadline = setTimeout(() => {
      console.error(
        `orcad: shutdown after ${signal} exceeded ${ORCAD_SHUTDOWN_DEADLINE_MS}ms — exiting`
      )
      process.exit(ORCAD_EXIT_FAILED)
    }, ORCAD_SHUTDOWN_DEADLINE_MS)
    deadline.unref()
    handle
      .stop()
      .then(() => process.exit(ORCAD_EXIT_OK))
      // Why not rethrow: we are already tearing down on a signal, and an exit code is
      // the only thing a supervisor can act on.
      .catch((error) => {
        console.error(`orcad: shutdown after ${signal} failed:`, error)
        process.exit(ORCAD_EXIT_FAILED)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
