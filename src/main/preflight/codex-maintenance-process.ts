import { spawnProcess } from '@orca/process-host'
import type {
  PipedProcessSpawner,
  ProcessSpec,
  SpawnedProcess
} from '@orca/process-host/process-spec'
import {
  codexMaintenanceWindowsSpawnSpec,
  CODEX_MAINTENANCE_PROVIDER_EXIT
} from './codex-maintenance-windows-supervisor'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import {
  createProviderSpawnSpec,
  PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS
} from '../provider-process/provider-process-supervisor'
import { stopSupervisedChildProcess } from '../provider-process/supervised-child-process-stop'
import { waitForProcessExitUntil } from '../provider-process/provider-process-exit-deadline'

type ProcessOutcome = {
  code: number | null
  error: string | null
  termination: 'exited' | 'unverifiable'
  isLive: () => boolean
}

export async function executeCodexMaintenanceProcess(
  spec: ProcessSpec,
  append: (chunk: Buffer | string) => void,
  options: {
    spawn?: PipedProcessSpawner
    timeoutMs?: number
    platform?: NodeJS.Platform
    stop?: (child: SpawnedProcess, supervised: boolean) => Promise<boolean>
  } = {}
): Promise<ProcessOutcome> {
  const platform = options.platform ?? process.platform
  const launch = createProviderSpawnSpec(
    { command: spec.program, args: [...(spec.args ?? [])], cwd: spec.cwd },
    spec.env ?? process.env,
    platform,
    { lifetime: 'one-shot' }
  )
  const child = (options.spawn ?? spawnProcess)(
    platform === 'win32' ? codexMaintenanceWindowsSpawnSpec(spec) : launch
  )
  const isLive = (): boolean =>
    Boolean(child.pid && child.exitCode === null && child.signalCode === null)
  let code: number | null = null
  let error: string | null = null
  let termination: ProcessOutcome['termination'] = 'exited'
  const stopRequest: { current: Promise<void> | null } = { current: null }
  let finish = (): void => {}
  const exited = new Promise<void>((resolve) => {
    finish = resolve
  })
  const stop =
    options.stop ??
    (async (owned: SpawnedProcess, supervised: boolean) => {
      if (!supervised) {
        return forceTerminateProcessTree(owned)
      }
      const result = await stopSupervisedChildProcess(owned, { site: 'codex-maintenance-timeout' })
      return result.root === 'exited' && owned.exitCode !== 1
    })
  const beginStop = (): void => {
    if (stopRequest.current) {
      return
    }
    stopRequest.current = (async () => {
      let verified = false
      await waitForProcessExitUntil(
        stop(child, launch.supervised)
          .then((result) => {
            verified = result
          })
          .catch(() => {}),
        10_000
      )
      if (!verified) {
        termination = 'unverifiable'
        error = `${error ?? ''} Process termination is unverifiable.`.trim()
      }
      finish()
    })()
  }
  const timer = setTimeout(
    () => {
      error = 'Codex maintenance timed out.'
      beginStop()
    },
    options.timeoutMs ?? 10 * 60_000
  )
  timer.unref()
  const streamError = (failure: Error): void => append(`\n${failure.message}\n`)
  const processError = (failure: Error): void => {
    error = failure.message
    if (!child.pid) {
      finish()
    }
  }
  let providerOutcome = false
  const processExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (providerOutcome) {
      return
    }
    code = exitCode
    // The supervisor uses exit 1 when it cannot prove its descendants exited.
    if ((launch.supervised && exitCode === 1) || platform === 'win32') {
      termination = 'unverifiable'
      error ??= 'Codex maintenance process termination is unverifiable.'
    }
    if (signal && !error) {
      error = `Command exited after signal ${signal}`
    }
    finish()
  }
  let pipesClosed = false
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => {
      pipesClosed = true
      resolve()
    })
  )
  const providerExit = (message: unknown): void => {
    if (
      platform !== 'win32' ||
      providerOutcome ||
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== CODEX_MAINTENANCE_PROVIDER_EXIT ||
      !('code' in message) ||
      (message.code !== null && typeof message.code !== 'number')
    ) {
      return
    }
    providerOutcome = true
    code = message.code
    if ('error' in message && typeof message.error === 'string') {
      error = message.error
    }
    if ('signal' in message && typeof message.signal === 'string') {
      error ??= `Command exited after signal ${message.signal}`
    }
    void waitForProcessExitUntil(closed, PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS).then(beginStop)
  }
  child.on('message', providerExit)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.on('error', streamError)
  }
  child.once('error', processError)
  child.once('exit', processExit)
  try {
    child.stdin.end()
    await exited
    await stopRequest.current
    clearTimeout(timer)
    await waitForProcessExitUntil(closed, PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS)
    if (isLive() || !pipesClosed) {
      termination = 'unverifiable'
      error ??= 'Codex maintenance process termination is unverifiable.'
    }
    return { code, error, termination, isLive }
  } finally {
    clearTimeout(timer)
    child.removeListener('error', processError)
    child.removeListener('exit', processExit)
    child.removeListener('message', providerExit)
    child.stdout.removeListener('data', append)
    child.stderr.removeListener('data', append)
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.removeListener('error', streamError)
      stream.destroy()
    }
  }
}
