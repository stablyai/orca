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
 * `describeUnavailable()` gives the reason a client can surface.
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
    describeUnavailable: () =>
      'This host has no OS keyring, so credentials are stored unencrypted. Pair from a desktop to manage secrets, or install and unlock a keyring.'
  }
}

export function installOrcadHostAdapters(): void {
  setAppEnvironment(createNodeAppEnvironment())
  setSecretStore(createNodeSecretStore())
}

/** Boot the runtime and serve RPC. Returns once the transport is listening. */
export async function startOrcad(options: { port?: number } = {}): Promise<void> {
  installOrcadHostAdapters()

  const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
  const { OrcaRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const { registerPtyHandlers } = await import('../ipc/pty')
  const { getAppEnvironment } = await import('../../shared/app-environment')

  const runtime = new OrcaRuntimeService(null, undefined, {
    // Why false: this host does not run the terminal daemon, so persistent local PTYs
    // cannot be recovered. The constructor defaults this to true, which would claim a
    // capability orcad does not have.
    canRecoverPersistentLocalPtys: () => false,
    // Why 'blocked': `'openable'` means a desktop window can be opened here, which is
    // what powers serve→desktop promotion. A Node host can never do that, and the
    // constructor's default would advertise it.
    getDesktopWindowStatus: () => 'blocked'
  })

  // Why null: no renderer. This installs the RuntimePtyController that terminal.create
  // spawns through — the whole reason this module had to stop importing electron.
  registerPtyHandlers(null, runtime)

  const rpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: getAppEnvironment().getPath('userData'),
    enableWebSocket: true,
    exposeNetworkByDefault: true,
    ...(options.port !== undefined ? { wsPort: options.port, preferPinnedWsPort: true } : {})
  } as never)
  await rpc.start()
}
