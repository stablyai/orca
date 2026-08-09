import { app } from 'electron'
import { connect as netConnect, type Socket } from 'node:net'
import type { DebugAdapterConfig } from '../../shared/debug-session-types'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import {
  LocalDebugAdapterProcessHost,
  type DebugAdapterProcess,
  type DebugAdapterProcessHost
} from './debug-adapter-process-host'
import {
  resolveDapDebugServerEntrypoint,
  resolveJsDebugAdapterRoot
} from './js-debug-adapter-bundle'
import { pickFreeLocalPort } from './js-debug-local-port'
import { waitForJsDebugListeningPort } from './js-debug-listening-port'
import { resolveRemoteJsDebugEntrypoint } from './js-debug-remote-bundle'
import { createJsDebugSessionBridge } from './js-debug-session-bridge'
import { SshDebugAdapterProcessHost, type GetSshConnection } from './ssh-debug-adapter-process-host'

export type { GetSshConnection } from './ssh-debug-adapter-process-host'

export type JsDebugBundleLocation = { isPackaged: boolean; resourcesPath: string; appPath: string }

function defaultBundleLocation(): JsDebugBundleLocation {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  }
}

function connectSocket(port: number, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, host)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

/**
 * Spawns vscode-js-debug's `dapDebugServer.js` on the local host (or inside
 * WSL, matching `LocalDebugAdapterProcessHost`'s existing wrap) and bridges
 * its cascaded parent/child session model behind Phase 0's plain
 * `DebugAdapterProcessHost` contract via `createJsDebugSessionBridge`.
 */
export class LocalJsDebugAdapterProcessHost implements DebugAdapterProcessHost {
  constructor(
    private readonly wslDistro?: string,
    // Why lazy: resolved in `spawn()`, not here — this class is constructed
    // on every `resolveDebugAdapterProcessHost()` call (including ones that
    // never spawn anything, e.g. tests), and `app.isPackaged` is only safe
    // to read once Electron's main process is actually up.
    private readonly bundleLocation?: JsDebugBundleLocation
  ) {}

  async spawn(config: DebugAdapterConfig): Promise<DebugAdapterProcess> {
    const bundleLocation = this.bundleLocation ?? defaultBundleLocation()
    const entrypoint = resolveDapDebugServerEntrypoint(resolveJsDebugAdapterRoot(bundleLocation))
    // Why ELECTRON_RUN_AS_NODE: this runs the adapter binary itself (a build
    // tool), not the user's debug target — Electron's own executable, run as
    // plain Node, avoids depending on a separate `node` binary on PATH.
    // Inside WSL we do need PATH resolution since Electron's Windows binary
    // is unreachable from the distro's namespace.
    const command = this.wslDistro ? 'node' : process.execPath
    const env = this.wslDistro ? config.env : { ...config.env, ELECTRON_RUN_AS_NODE: '1' }

    const serverHost = new LocalDebugAdapterProcessHost(this.wslDistro)
    const serverProcess = await serverHost.spawn({
      type: config.type,
      request: config.request,
      command,
      args: [entrypoint, '0', '127.0.0.1'],
      cwd: config.cwd,
      env
    })

    let port: number
    try {
      port = await waitForJsDebugListeningPort(serverProcess.stdout)
    } catch (err) {
      serverProcess.kill()
      throw err
    }

    const bridge = createJsDebugSessionBridge(() => connectSocket(port, '127.0.0.1'))
    await bridge.ready

    return {
      stdin: bridge.stdin,
      stdout: bridge.stdout,
      stderr: serverProcess.stderr,
      kill: () => {
        bridge.kill()
        serverProcess.kill()
      }
    }
  }
}

/**
 * Same bridging as `LocalJsDebugAdapterProcessHost`, but the adapter runs on
 * an SSH remote — "the adapter process must run beside the code it's
 * debugging" (see AGENTS.md's Remote/SSH guidance). Since js-debug speaks
 * DAP over a TCP port it opens on the remote host rather than over the exec
 * channel's stdio, we forward that port back to a local one with
 * `SshPortForwardManager` and connect to it exactly like the local case.
 */
export class SshJsDebugAdapterProcessHost implements DebugAdapterProcessHost {
  constructor(
    private readonly connectionId: string,
    private readonly getConnection: GetSshConnection
  ) {}

  async spawn(config: DebugAdapterConfig): Promise<DebugAdapterProcess> {
    const connection = this.getConnection(this.connectionId)
    if (!connection) {
      throw new Error(`No SSH connection for "${this.connectionId}"`)
    }
    const entrypoint = await resolveRemoteJsDebugEntrypoint(connection)

    const serverHost = new SshDebugAdapterProcessHost(this.connectionId, this.getConnection)
    const serverProcess = await serverHost.spawn({
      type: config.type,
      request: config.request,
      command: 'node',
      args: [entrypoint, '0', '127.0.0.1'],
      cwd: config.cwd,
      env: config.env
    })

    const forwardManager = new SshPortForwardManager()
    let localPort: number
    try {
      const remotePort = await waitForJsDebugListeningPort(serverProcess.stdout)
      localPort = await pickFreeLocalPort()
      await forwardManager.addForward(
        this.connectionId,
        connection,
        localPort,
        '127.0.0.1',
        remotePort
      )
    } catch (err) {
      serverProcess.kill()
      throw err
    }

    const bridge = createJsDebugSessionBridge(() => connectSocket(localPort, '127.0.0.1'))
    await bridge.ready

    return {
      stdin: bridge.stdin,
      stdout: bridge.stdout,
      stderr: serverProcess.stderr,
      kill: () => {
        bridge.kill()
        serverProcess.kill()
        forwardManager.dispose()
      }
    }
  }
}
