/**
 * `orcad` — the Orca runtime served from plain Node, with no Electron.
 *
 * Installs the Node host adapters, constructs the same `OrcaRuntimeService` the
 * desktop uses, installs a PTY controller via `registerPtyHandlers(null, …)`, and
 * serves runtime RPC. See docs/design/node-only-runtime-backend.html.
 *
 * The desktop-only surfaces are deliberately left uninstalled: no notifications, no
 * renderer window, no browser panes. Those are declared rather than faked — see
 * `runtime-desktop-surface.ts` and `pty-host-bindings.ts`.
 */
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { setSecretStore, type SecretStore } from '../../shared/secret-store'
import type { ServeReadiness } from '../server/serve-readiness'

/** XDG-ish data root. `$ORCA_USER_DATA` wins so a smoke test can isolate state. */
function resolveUserDataPath(): string {
  const explicit = process.env.ORCA_USER_DATA
  if (explicit) {
    return explicit
  }
  const xdg = process.env.XDG_DATA_HOME
  return xdg ? join(xdg, 'Orca') : join(homedir(), '.orca')
}

function createNodeAppEnvironment(): AppEnvironment {
  const userData = resolveUserDataPath()
  const quitHandlers: (() => void)[] = []
  // Why SIGTERM/SIGINT: this is the Node equivalent of electron's will-quit, and the
  // runtime's teardown (daemon disconnect, PTY kill, store flush) hangs off it.
  const runQuitHandlers = (): void => {
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        console.error('[orcad] shutdown handler failed:', error)
      }
    }
  }
  process.once('SIGTERM', () => {
    runQuitHandlers()
    process.exit(0)
  })
  process.once('SIGINT', () => {
    runQuitHandlers()
    process.exit(0)
  })
  return {
    getPath: (name) => (name === 'home' ? homedir() : name === 'temp' ? tmpdir() : userData),
    getAppPath: () => process.cwd(),
    getVersion: () => process.env.ORCA_VERSION ?? '0.0.0-orcad',
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

  const userDataPath = getAppEnvironment().getPath('userData')
  initOrcaProfilePaths()
  const profile = ensureActiveOrcaProfile(userDataPath)
  // Why a real Store: without one every persistence-backed RPC throws `runtime_unavailable`
  // and the read paths that use `this.store?.x ?? []` quietly answer "empty" instead —
  // a server that pairs and lists nothing looks healthy and is not.
  const store = new Store({ dataFile: profile.dataFile })
  // Why: every SSH connect consults this sidecar. Left unbound it reports nothing trusted,
  // which is safe but silently discards accept records on every launch.
  initSshHostKeyStoreFile(profile.dataFile)

  const runtime = new OrcaRuntimeService(store, undefined, {
    // Why lazy: a daemon swap replaces the provider after construction, so an eager
    // reference would freeze the pre-daemon one.
    getLocalProvider: () => getLocalPtyProvider(),
    // Why: destructive worktree removal refuses to run without a provider to stop
    // processes through — correctly, since it cannot otherwise verify the tree is idle.
    getSshProvider: (connectionId) => getSshPtyProvider(connectionId),
    // Why false: this host does not run the terminal daemon, so persistent local PTYs
    // cannot be recovered. The constructor defaults this to true, which would claim a
    // capability orcad does not have.
    canRecoverPersistentLocalPtys: () => false,
    // Why 'blocked': `'openable'` means a desktop window can be opened here, which is
    // what powers serve→desktop promotion. A Node host can never do that, and the
    // constructor's default would advertise it.
    getDesktopWindowStatus: () => 'blocked'
  })

  // Why the headless entry point rather than registerPtyHandlers(null, …): this is the
  // same call `--serve` makes, and it threads the store through. Without the store the
  // handlers install fine and every terminal.create then fails at persistence time.
  //
  // Codex-home and Claude-auth preparation are left unset: both are desktop account
  // flows. A launch that needs one fails with its own message rather than silently
  // spawning an unauthenticated agent.
  registerHeadlessPtyRuntime(runtime, undefined, () => store.getSettings(), undefined, store)

  // Why: same post-registration reconciliation `--serve` performs. Skipping it leaves
  // restored orchestration rows claiming an authority this host never took over.
  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()

  const rpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    exposeNetworkByDefault: true,
    ...(options.port !== undefined ? { wsPort: options.port, preferPinnedWsPort: true } : {})
  })
  await rpc.start()

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
      : offer
  }

  await new ServeReadinessPublisher().publish(readiness, {
    mode: options.json ? 'json' : 'human'
  })

  return {
    readiness,
    stop: async () => {
      await rpc.stop()
    }
  }
}

function parseArgs(argv: string[]): OrcadOptions {
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const handle = await startOrcad(parseArgs(argv))
  let stopping = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return
    }
    stopping = true
    handle
      .stop()
      .then(() => process.exit(0))
      // Why not rethrow: we are already tearing down on a signal, and an exit code is
      // the only thing a supervisor can act on.
      .catch((error) => {
        console.error(`orcad: shutdown after ${signal} failed:`, error)
        process.exit(1)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
