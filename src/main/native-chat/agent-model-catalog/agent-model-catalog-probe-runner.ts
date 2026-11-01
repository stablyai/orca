import type { ClaudeBackgroundFailedExit } from '../../../shared/claude-background-run-isolation'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'

import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import { spawnManagedProviderProcess } from '../../provider-process/managed-provider-process'
import type { ProviderProcessClosePolicy } from '../../provider-process/provider-process-close'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../provider-process/provider-process-supervisor'
import {
  providerStderrForDisplay,
  supervisedProviderSpawnFailure
} from '../../provider-process/provider-spawn-failure-report'

// Allow cold network-backed listings; timed-out pickers retain their existing catalog.
export const AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS = 15_000
export const AGENT_MODEL_CATALOG_PROBE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const STDERR_DETAIL_MAX_CHARS = 400
const UNSUPERVISED_GRACEFUL_EXIT_MS = 1_500
const FORCED_EXIT_MS = 1_000

export type AgentModelCatalogProbeFailure =
  | 'timeout'
  | 'output-overflow'
  | 'exit'
  | 'spawn'
  | 'stopped'

export class AgentModelCatalogProbeError extends Error {
  constructor(
    message: string,
    readonly reason: AgentModelCatalogProbeFailure,
    readonly executableMissing = false,
    readonly failedExit?: ClaudeBackgroundFailedExit
  ) {
    super(message)
    this.name = 'AgentModelCatalogProbeError'
  }
}

function probeClosePolicy(supervised: boolean): ProviderProcessClosePolicy {
  return {
    gracefulExitMs: supervised ? PROVIDER_SUPERVISOR_MAX_STOP_MS : UNSUPERVISED_GRACEFUL_EXIT_MS,
    forcedExitMs: FORCED_EXIT_MS,
    signalSupervisorOnClose: true
  }
}

export type AgentModelCatalogListingLaunch = ProviderProcessLaunch & {
  /** End stdin after the request; absent requests still receive immediate EOF. */
  stdin?: string
}

export type AgentModelCatalogRunnerOptions = {
  site: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  spawnImpl?: PipedProcessSpawner
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
}

/** Bound the listing and await child teardown before success, failure or cancellation settles. */
export async function runAgentModelCatalogListing(
  launch: AgentModelCatalogListingLaunch,
  options: AgentModelCatalogRunnerOptions
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS
  throwIfStopped(options.signal, launch.command)
  const managed = spawnManagedProviderProcess(launch, {
    site: options.site,
    // Request EOF completes input without requesting process shutdown.
    lifetime: 'one-shot',
    policy: probeClosePolicy,
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.inheritedEnv ? { inheritedEnv: options.inheritedEnv } : {})
  })
  const { child } = managed
  const output = createOutputSink(
    options.maxOutputBytes ?? AGENT_MODEL_CATALOG_PROBE_MAX_OUTPUT_BYTES
  )
  const stderrDetail = (): string =>
    providerStderrForDisplay(managed.stderrTail()).trim().slice(0, STDERR_DETAIL_MAX_CHARS)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort = (): void => {}
  try {
    return await new Promise<string>((resolve, reject) => {
      const fail = (
        message: string,
        reason: AgentModelCatalogProbeFailure,
        failedExit?: ClaudeBackgroundFailedExit
      ): void =>
        reject(
          new AgentModelCatalogProbeError(
            message,
            reason,
            reason === 'spawn' && managed.executableMissing,
            failedExit
          )
        )
      onAbort = () => fail(`${launch.command} listing stopped`, 'stopped')
      options.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
        () => fail(`${launch.command} did not list models within ${timeoutMs}ms`, 'timeout'),
        timeoutMs
      )
      child.stdout.on('data', (chunk: Buffer | string) => {
        output.write(chunk)
        if (output.truncated()) {
          fail(`${launch.command} listed more than the model catalog reads`, 'output-overflow')
        }
      })
      child.stdout.on('error', () => {})
      child.stdin.on('error', () => {})
      child.on('error', (error) => {
        if (child.pid === undefined) {
          fail(`${launch.command} could not start: ${error.message}`, 'spawn')
        }
      })
      // close follows stdout drainage; exit may arrive before the final bytes.
      child.on('close', (code: number | null) => {
        const spawnFailure = managed.supervised
          ? supervisedProviderSpawnFailure(code, managed.stderrTail())
          : null
        if (spawnFailure) {
          fail(`${launch.command} could not start: ${spawnFailure.error.message}`, 'spawn')
        } else if (code === 0) {
          resolve(output.text())
        } else {
          const detail = stderrDetail()
          fail(
            `${launch.command} exited ${code ?? 'by signal'}${detail ? `: ${detail}` : ''}`,
            'exit',
            { exitCode: code, stdout: output.text(), stderr: managed.stderrTail() }
          )
        }
      })
      try {
        child.stdin.end(launch.stdin ?? '')
      } catch {}
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    await managed.close()
  }
}

function throwIfStopped(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) {
    throw new AgentModelCatalogProbeError(`${label} listing stopped`, 'stopped')
  }
}

export type AgentModelCatalogProbeConnection = { close(): Promise<unknown> }

export async function runAgentModelCatalogSession<C extends AgentModelCatalogProbeConnection, T>(
  open: () => C,
  body: (connection: C) => Promise<T>,
  options: { label: string; timeoutMs?: number; signal?: AbortSignal }
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS
  throwIfStopped(options.signal, options.label)
  const connection = open()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort = (): void => {}
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(new AgentModelCatalogProbeError(`${options.label} listing stopped`, 'stopped'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(
      () =>
        reject(
          new AgentModelCatalogProbeError(
            `${options.label} did not list models within ${timeoutMs}ms`,
            'timeout'
          )
        ),
      timeoutMs
    )
  })
  try {
    return await Promise.race([body(connection), deadline])
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    await connection.close().catch(() => undefined)
  }
}
