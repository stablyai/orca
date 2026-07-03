/**
 * Headless `@stablyai/orca-server` entrypoint — boots the Orca runtime under PLAIN NODE,
 * with no Electron in the process. It installs Node-backed implementations of
 * the host abstractions (AppEnvironment, SecretStore, managed fetch), constructs
 * the same OrcaRuntimeService + OrcaRuntimeRpcServer the desktop app uses, wires
 * the headless PTY runtime, and prints a pairing URL on stdout.
 *
 * Desktop-only capabilities (offscreen browser panes, tray, native
 * notifications, auto-updater) are intentionally NOT installed; the runtime
 * advertises a reduced capability set and clients adapt — the same mechanism
 * that already gates browser panes when no display is present.
 *
 * This module must stay free of any `electron` import (direct or transitive) so
 * the server bundle carries no Electron dependency. The build aliases `electron`
 * to a throwing shim to enforce that at bundle time.
 */
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { setAppEnvironment } from '../../shared/app-environment'
import { setSecretStore } from '../../shared/secret-store'
import { NodeAppEnvironment } from './node-app-environment'
import { NodeSecretStore } from './node-secret-store'
import { warnIfSharingDesktopUserData } from './shared-user-data-guard'
import { parseServerArgs, type NodeServerOptions, printNodeServerHelp } from './node-server-args'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'

export async function runNodeServer(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseServerArgs(argv)
  if (options.help) {
    printNodeServerHelp()
    return
  }

  // 1. Install host abstractions BEFORE any consumer resolves a path/secret.
  const explicitlyConfiguredUserData = Boolean(
    options.userDataPath || process.env.ORCA_USER_DATA_PATH
  )
  const env = new NodeAppEnvironment({ userDataPath: options.userDataPath })
  setAppEnvironment(env)
  const userDataPath = env.getPath('userData')
  // Why: terminals spawned by the server run `orca ...` locally. Pin the
  // inherited CLI lookup path to this server's metadata, including --user-data.
  process.env.ORCA_USER_DATA_PATH = userDataPath
  // Warn if we're about to share a desktop install's userData (data-race risk).
  warnIfSharingDesktopUserData({
    userDataPath,
    explicitlyConfigured: explicitlyConfiguredUserData
  })
  // Why: the desktop app relies on Electron having created userData already.
  // Headless must create it itself before the RPC server binds its Unix socket
  // (join(userDataPath, 'o-<pid>.sock')) or persistence writes its data file —
  // otherwise listen() fails with EACCES/ENOENT on a missing directory.
  mkdirSync(userDataPath, { recursive: true })
  setSecretStore(new NodeSecretStore({ userDataPath }))
  // managed fetch keeps its Node global-fetch default (no electron net.fetch).

  // 2. Construct the runtime + persistence. The Store and runtime both tolerate
  //    a minimal headless wiring (store is optional; absent desktop services
  //    surface as reduced capabilities, not crashes).
  const { Store, initDataPath } = await import('../persistence')
  const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
  const { OrcaRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const { registerHeadlessPtyRuntime } = await import('../ipc/pty')

  initDataPath()
  const store = new Store()
  const runtime = new OrcaRuntimeService(store)

  const runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    // The WebSocket transport binds 0.0.0.0 by default, so the server is
    // reachable from outside the container without extra configuration.
    ...(options.port !== undefined ? { wsPort: options.port } : {}),
    webClientRoot: resolveWebClientRoot(env.getAppPath())
  })

  // 3. Headless PTY runtime: terminals/agents over RPC, pure node-pty.
  registerHeadlessPtyRuntime(runtime, undefined, () => store.getSettings(), undefined, store)

  // 4. No offscreen browser backend, no window graph publisher — publish an
  //    empty graph so status clients see a ready server.
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

  installSignalHandlers(env)

  await runtimeRpc.start().catch((error) => {
    console.error('[orca-server] Failed to start RPC transport:', error)
    throw error
  })

  await printServerReady(runtimeRpc, runtime, options)
}

function resolveWebClientRoot(appPath: string): string | undefined {
  // Why: the bundled static web client lets paired web/mobile clients connect to
  // the headless server. Mirrors getBundledWebClientRoot() in the desktop path.
  const root = join(appPath, 'out', 'web')
  return existsSync(join(root, 'web-index.html')) ? root : undefined
}

function installSignalHandlers(env: { onWillQuit(cb: () => void): void }): void {
  // NodeAppEnvironment.onWillQuit installs SIGTERM/SIGINT handlers; registering a
  // no-op hook ensures they are wired so a container stop exits cleanly.
  env.onWillQuit(() => {
    console.error('[orca-server] shutting down')
  })
}

async function printServerReady(
  runtimeRpc: OrcaRuntimeRpcServer,
  runtime: OrcaRuntimeService,
  options: NodeServerOptions
): Promise<void> {
  const endpoint = runtimeRpc.getWebSocketEndpoint()
  const pairing = options.noPairing
    ? ({ available: false } as const)
    : runtimeRpc.createPairingOffer({
        address: options.pairingAddress,
        name: `${options.mobilePairing ? 'Mobile' : 'CLI'} server`,
        scope: options.mobilePairing ? 'mobile' : 'runtime'
      })

  if (options.json) {
    console.log(
      JSON.stringify({
        type: 'orca_server_ready',
        runtimeId: runtime.getRuntimeId(),
        endpoint,
        pairing: pairing.available
          ? {
              url: pairing.pairingUrl,
              endpoint: pairing.endpoint,
              webClientUrl: pairing.webClientUrl,
              scope: options.mobilePairing ? 'mobile' : 'runtime'
            }
          : null
      })
    )
    return
  }

  console.log(`Orca server ready: ${endpoint ?? 'websocket unavailable'}`)
  if (pairing.available) {
    console.log(`Pairing URL: ${pairing.pairingUrl}`)
    if (pairing.webClientUrl) {
      console.log(`Web client URL: ${pairing.webClientUrl}`)
    }
  }
}
