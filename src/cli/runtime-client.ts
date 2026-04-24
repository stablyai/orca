/* eslint-disable max-lines -- Why: the runtime client owns the full local IPC contract, launch fallback, and response validation in one place so the CLI does not drift from the app runtime. */
import { createConnection } from 'net'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { readFileSync } from 'fs'
import { spawn as spawnProcess } from 'child_process'
import type { CliStatusResult, RuntimeStatus } from '../shared/runtime-types'
import {
  getRuntimeMetadataPath,
  type RuntimeMetadata,
  type RuntimeTransportMetadata
} from '../shared/runtime-bootstrap'

export type RuntimeRpcSuccess<TResult> = {
  id: string
  ok: true
  result: TResult
  _meta: {
    runtimeId: string
  }
}

export type RuntimeRpcFailure = {
  id: string
  ok: false
  error: {
    code: string
    message: string
    data?: unknown
  }
  _meta?: {
    runtimeId: string | null
  }
}

type RuntimeRpcResponse<TResult> = RuntimeRpcSuccess<TResult> | RuntimeRpcFailure

export class RuntimeClientError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class RuntimeRpcFailureError extends RuntimeClientError {
  readonly response: RuntimeRpcFailure

  constructor(response: RuntimeRpcFailure) {
    super(response.error.code, response.error.message)
    this.response = response
  }
}

export class RuntimeClient {
  private readonly userDataPath: string
  private readonly requestTimeoutMs: number

  // Why: browser commands trigger first-time session init (agent-browser connect +
  // CDP proxy setup) which can take 15-30s. 60s accommodates cold start without
  // being so large that genuine hangs go unnoticed.
  constructor(userDataPath = getDefaultUserDataPath(), requestTimeoutMs = 60_000) {
    this.userDataPath = userDataPath
    this.requestTimeoutMs = requestTimeoutMs
  }

  async call<TResult>(
    method: string,
    params?: unknown,
    options?: {
      timeoutMs?: number
    }
  ): Promise<RuntimeRpcSuccess<TResult>> {
    const metadata = this.readMetadata()
    const response = await this.sendRequest<TResult>(metadata, method, params, options?.timeoutMs)
    if (!response.ok) {
      throw new RuntimeRpcFailureError(response)
    }
    return response
  }

  async getCliStatus(): Promise<RuntimeRpcSuccess<CliStatusResult>> {
    const metadata = this.tryReadMetadata()
    if (!metadata?.transport || !metadata.authToken) {
      return buildCliStatusResponse({
        app: {
          running: false,
          pid: null
        },
        runtime: {
          // Why: distinguishing "never started" from "was running but died"
          // gives the user a better signal about what happened. If the metadata
          // file exists, Orca was running at some point.
          state: metadata ? 'stale_bootstrap' : 'not_running',
          reachable: false,
          runtimeId: null
        },
        graph: {
          state: 'not_running'
        }
      })
    }

    try {
      const response = await this.sendRequest<RuntimeStatus>(
        metadata,
        'status.get',
        undefined,
        1000
      )
      if (!response.ok) {
        throw new RuntimeRpcFailureError(response)
      }
      const graphState = response.result.graphStatus
      return buildCliStatusResponse({
        app: {
          running: true,
          pid: metadata.pid
        },
        runtime: {
          state: graphState === 'ready' ? 'ready' : 'graph_not_ready',
          reachable: true,
          runtimeId: response.result.runtimeId
        },
        graph: {
          state: graphState
        }
      })
    } catch {
      const running = isProcessRunning(metadata.pid)
      return buildCliStatusResponse({
        app: {
          running,
          pid: running ? metadata.pid : null
        },
        runtime: {
          state: running ? 'starting' : 'stale_bootstrap',
          reachable: false,
          runtimeId: null
        },
        graph: {
          state: running ? 'starting' : 'not_running'
        }
      })
    }
  }

  async openOrca(timeoutMs = 15_000): Promise<RuntimeRpcSuccess<CliStatusResult>> {
    const initial = await this.getCliStatus()
    if (initial.result.runtime.reachable) {
      return initial
    }

    launchOrcaApp()
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.getCliStatus()
      if (status.result.runtime.reachable) {
        return status
      }
      await delay(250)
    }

    throw new RuntimeClientError(
      'runtime_open_timeout',
      'Timed out waiting for Orca to start. Run the Orca app manually and try again.'
    )
  }

  private readMetadata(): RuntimeMetadata {
    const metadataPath = getRuntimeMetadataPath(this.userDataPath)
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadata | null
      if (!metadata?.transport || !metadata.authToken) {
        throw new RuntimeClientError(
          'runtime_unavailable',
          `Orca runtime metadata is incomplete at ${metadataPath}`
        )
      }
      return metadata
    } catch (error) {
      if (error instanceof RuntimeClientError) {
        throw error
      }
      throw new RuntimeClientError(
        'runtime_unavailable',
        `Could not read Orca runtime metadata at ${metadataPath}. Start the Orca app first.`
      )
    }
  }

  private tryReadMetadata(): RuntimeMetadata | null {
    const metadataPath = getRuntimeMetadataPath(this.userDataPath)
    try {
      return JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadata | null
    } catch {
      return null
    }
  }

  private async sendRequest<TResult>(
    metadata: RuntimeMetadata,
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<RuntimeRpcResponse<TResult>> {
    return await new Promise((resolve, reject) => {
      const socket = createConnection(getTransportEndpoint(metadata.transport!))
      let buffer = ''
      const requestId = randomUUID()

      const timeout = setTimeout(() => {
        socket.destroy()
        reject(
          new RuntimeClientError(
            'runtime_timeout',
            'Timed out waiting for the Orca runtime to respond.'
          )
        )
      }, timeoutMs ?? this.requestTimeoutMs)

      socket.setEncoding('utf8')
      socket.once('error', () => {
        clearTimeout(timeout)
        reject(
          new RuntimeClientError(
            'runtime_unavailable',
            'Could not connect to the running Orca app. Restart Orca and try again.'
          )
        )
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex === -1) {
          return
        }
        const message = buffer.slice(0, newlineIndex)
        socket.end()
        clearTimeout(timeout)
        try {
          const response = JSON.parse(message) as RuntimeRpcResponse<TResult>
          if (response.id !== requestId) {
            reject(
              new RuntimeClientError(
                'invalid_runtime_response',
                'The Orca runtime returned a mismatched response id.'
              )
            )
            return
          }
          if (response._meta?.runtimeId && response._meta.runtimeId !== metadata.runtimeId) {
            reject(
              new RuntimeClientError(
                'runtime_unavailable',
                'The Orca runtime changed while the request was in flight. Retry the command.'
              )
            )
            return
          }
          resolve(response)
        } catch {
          reject(
            new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned an invalid response frame.'
            )
          )
        }
      })
      socket.on('connect', () => {
        socket.write(
          `${JSON.stringify({
            id: requestId,
            authToken: metadata.authToken,
            method,
            params
          })}\n`
        )
      })
    })
  }
}

function buildCliStatusResponse(result: CliStatusResult): RuntimeRpcSuccess<CliStatusResult> {
  return {
    id: 'local-status',
    ok: true,
    result,
    _meta: {
      runtimeId: result.runtime.runtimeId ?? 'none'
    }
  }
}

function isProcessRunning(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function launchOrcaApp(): void {
  const overrideCommand = process.env.ORCA_OPEN_COMMAND
  if (typeof overrideCommand === 'string' && overrideCommand.trim().length > 0) {
    spawnProcess(overrideCommand, {
      detached: true,
      stdio: 'ignore',
      shell: true
    }).unref()
    return
  }

  const overrideExecutable = process.env.ORCA_APP_EXECUTABLE
  if (typeof overrideExecutable === 'string' && overrideExecutable.trim().length > 0) {
    spawnProcess(overrideExecutable, [], {
      detached: true,
      stdio: 'ignore',
      env: stripElectronRunAsNode(process.env)
    }).unref()
    return
  }

  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    if (process.platform === 'darwin') {
      const appBundlePath = getMacAppBundlePath(process.execPath)
      if (appBundlePath) {
        // Why: launching the inner MacOS binary directly can trigger macOS app
        // launch failures and bypass normal bundle lifecycle. The public
        // packaged CLI should re-open the .app the same way Finder does.
        spawnProcess('open', [appBundlePath], {
          detached: true,
          stdio: 'ignore',
          env: stripElectronRunAsNode(process.env)
        }).unref()
        return
      }
    }

    spawnProcess(process.execPath, [], {
      detached: true,
      stdio: 'ignore',
      env: stripElectronRunAsNode(process.env)
    }).unref()
    return
  }

  throw new RuntimeClientError(
    'runtime_open_failed',
    'Could not determine how to launch Orca. Start Orca manually and try again.'
  )
}

function stripElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  return next
}

function getMacAppBundlePath(execPath: string): string | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const macOsDir = dirname(execPath)
  const contentsDir = dirname(macOsDir)
  const appBundlePath = dirname(contentsDir)
  return appBundlePath.endsWith('.app') ? appBundlePath : null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getTransportEndpoint(transport: RuntimeTransportMetadata): string {
  return transport.endpoint
}

export function getDefaultUserDataPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir()
): string {
  // Why: in dev mode (and for parallel Orca instances), the Electron app writes
  // runtime metadata to a separate userData directory (e.g. `orca-dev`) to avoid
  // clobbering the production app's metadata. The CLI needs to find the same
  // metadata file, so this env var lets the CLI target a specific instance.
  if (process.env.ORCA_USER_DATA_PATH) {
    return process.env.ORCA_USER_DATA_PATH
  }
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'orca')
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) {
      throw new RuntimeClientError(
        'runtime_unavailable',
        'APPDATA is not set, so the Orca runtime metadata path cannot be resolved.'
      )
    }
    return join(appData, 'orca')
  }
  // Why: the CLI must find the same metadata file Electron writes in packaged
  // runs, so this mirrors Electron's default userData base instead of inventing
  // a CLI-specific config path.
  return join(process.env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'orca')
}
