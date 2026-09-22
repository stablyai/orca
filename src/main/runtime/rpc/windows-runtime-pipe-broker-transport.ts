import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '../../../shared/child-process/run-process'
import type { RpcTransport } from './transport'

const BROKER_FLAG = 'ORCA_EXPERIMENTAL_WINDOWS_PIPE_BROKER'
const BROKER_SANDBOX_ACCOUNT = 'ORCA_EXPERIMENTAL_WINDOWS_PIPE_BROKER_SANDBOX_ACCOUNT'
const BROKER_READY_TIMEOUT_MS = 5_000
const BROKER_SESSION_DEADLINE_MS = 30_000

export type WindowsRuntimePipeBrokerOptions = {
  serverPid: number
  runtimeId: string
  authorizedSandboxAccount: string
  executablePath?: string
  instanceId?: string
  sessionDeadlineMs?: number
  onUnexpectedExit?: (details: {
    endpoint: string
    code: number | null
    signal: NodeJS.Signals | null
  }) => void
}

export function isWindowsRuntimePipeBrokerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BROKER_FLAG] === '1'
}

export function readWindowsRuntimePipeBrokerSandboxAccount(
  env: NodeJS.ProcessEnv = process.env
): string {
  const account = env[BROKER_SANDBOX_ACCOUNT]?.trim()
  if (!account) {
    throw new Error(
      `${BROKER_SANDBOX_ACCOUNT} must name one explicit local sandbox user when the experimental broker is enabled.`
    )
  }
  return account
}

export function resolveWindowsRuntimePipeBrokerPath(
  resourcesPath: string | undefined = process.resourcesPath
): string {
  // A packaged app must never fall back into a checkout when its channel
  // intentionally omitted the broker. start() turns this missing path into an
  // explicit feature-enable error before attempting to spawn anything.
  if (resourcesPath) {
    return join(resourcesPath, 'bin', 'orca-pipe-broker.exe')
  }
  return resolve('native', 'windows-runtime-pipe-broker', '.build', 'orca-pipe-broker.exe')
}

export class WindowsRuntimePipeBrokerTransport implements RpcTransport {
  readonly endpoint: string
  private readonly options: WindowsRuntimePipeBrokerOptions
  private readonly instanceId: string
  private child: ChildProcessWithoutNullStreams | null = null
  private intentionalStop = false

  constructor(options: WindowsRuntimePipeBrokerOptions) {
    this.options = options
    const instanceId = options.instanceId ?? randomUUID().replaceAll('-', '')
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(instanceId)) {
      throw new Error('Invalid Windows runtime pipe broker instance id.')
    }
    this.instanceId = instanceId
    this.endpoint = `\\\\.\\pipe\\orca-broker-${instanceId}`
  }

  async start(): Promise<void> {
    if (this.child) {
      return
    }
    const executable = this.options.executablePath ?? resolveWindowsRuntimePipeBrokerPath()
    if (!existsSync(executable)) {
      throw new Error(`Windows runtime pipe broker is missing: ${executable}`)
    }
    const child = spawnProcess({
      program: executable,
      args: [],
      timeoutMs: null,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.intentionalStop = false
    this.child = child
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})

    const sessionDeadlineMs = this.options.sessionDeadlineMs ?? BROKER_SESSION_DEADLINE_MS
    if (
      !Number.isInteger(sessionDeadlineMs) ||
      sessionDeadlineMs < 1 ||
      sessionDeadlineMs > 120_000
    ) {
      child.kill()
      this.child = null
      throw new Error('Invalid Windows runtime pipe broker session deadline.')
    }
    child.stdin.end(
      [
        'ORCA_RUNTIME_PIPE_BROKER_V2',
        this.instanceId,
        String(this.options.serverPid),
        this.options.runtimeId,
        this.options.authorizedSandboxAccount,
        String(sessionDeadlineMs),
        ''
      ].join('\n')
    )

    try {
      await waitForReady(child, this.endpoint)
    } catch (error) {
      this.intentionalStop = true
      child.kill()
      this.child = null
      throw error
    }

    let exitHandled = false
    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exitHandled) {
        return
      }
      exitHandled = true
      if (this.child === child) {
        this.child = null
      }
      if (!this.intentionalStop) {
        this.options.onUnexpectedExit?.({ endpoint: this.endpoint, code, signal })
      }
    }
    child.once('exit', handleExit)
    if (child.exitCode !== null || child.signalCode !== null) {
      handleExit(child.exitCode, child.signalCode)
    }
  }

  async stop(): Promise<void> {
    this.intentionalStop = true
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return
    }
    child.kill()
    await waitForExit(child, 2_000)
  }

  /** Test-only seam: simulates a broker crash after its READY frame. */
  terminateForTest(): boolean {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return false
    }
    return child.kill('SIGKILL')
  }
}

function waitForReady(child: ChildProcessWithoutNullStreams, endpoint: string): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let output = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) {
        rejectReady(error)
      } else {
        resolveReady()
      }
    }
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString()
      const line = output.split(/\r?\n/, 1)[0]
      if (line === `READY ${endpoint}`) {
        finish()
      } else if (output.includes('\n')) {
        finish(new Error('Windows runtime pipe broker returned an invalid readiness frame.'))
      }
    }
    const onError = (): void => finish(new Error('Windows runtime pipe broker failed to start.'))
    const onExit = (code: number | null): void =>
      finish(new Error(`Windows runtime pipe broker exited before ready (code ${code ?? 'none'}).`))
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
    const timer = setTimeout(
      () => finish(new Error('Windows runtime pipe broker readiness timed out.')),
      BROKER_READY_TIMEOUT_MS
    )
  })
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolveExit, rejectExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit()
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectExit(new Error('Windows runtime pipe broker did not stop within its deadline.'))
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}
