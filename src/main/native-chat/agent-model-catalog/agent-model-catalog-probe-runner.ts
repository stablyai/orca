import type { ClaudeBackgroundFailedExit } from '../../../shared/claude-background-run-isolation'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { StringDecoder } from 'node:string_decoder'
import { withTimeout } from '../../../shared/promise-timeout-fallback'

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
  timeoutMs?: number | null
  maxOutputBytes?: number
  signal?: AbortSignal
  spawnImpl?: PipedProcessSpawner
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
  /** Finish required replies even when an optional control request never completes. */
  partialOutput?: { ready: (stdout: string) => boolean; timeoutMs: number }
  onOutput?: (chunk: string) => void
  completeOutput?: () => boolean
}

/** Bound the listing and await child teardown before success, failure or cancellation settles. */
export async function runAgentModelCatalogListing(
  launch: AgentModelCatalogListingLaunch,
  options: AgentModelCatalogRunnerOptions
): Promise<string> {
  const timeoutMs =
    options.timeoutMs === undefined ? AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS : options.timeoutMs
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
  const progressDecoder = options.onOutput ? new StringDecoder('utf8') : undefined
  const { child } = managed
  const output = createOutputSink(
    options.maxOutputBytes ?? AGENT_MODEL_CATALOG_PROBE_MAX_OUTPUT_BYTES
  )
  const stderrDetail = (): string =>
    providerStderrForDisplay(managed.stderrTail()).trim().slice(0, STDERR_DETAIL_MAX_CHARS)
  let timer: ReturnType<typeof setTimeout> | undefined
  let partialTimer: ReturnType<typeof setTimeout> | undefined
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
      // Required replies already in hand outlive an optional reply that runs out of time or room.
      const failUnlessReady = (message: string, reason: AgentModelCatalogProbeFailure): void =>
        partialTimer === undefined ? fail(message, reason) : resolve(output.text())
      onAbort = () =>
        isAgentModelCatalogWorkTimeout(options.signal)
          ? failUnlessReady(`${launch.command} listing timed out`, 'timeout')
          : fail(`${launch.command} listing stopped`, 'stopped')
      options.signal?.addEventListener('abort', onAbort, { once: true })
      timer =
        timeoutMs === null
          ? undefined
          : setTimeout(
              () =>
                failUnlessReady(
                  `${launch.command} did not list models within ${timeoutMs}ms`,
                  'timeout'
                ),
              timeoutMs
            )
      child.stdout.on('data', (chunk: Buffer | string) => {
        output.write(chunk)
        if (output.truncated()) {
          failUnlessReady(
            `${launch.command} listed more than the model catalog reads`,
            'output-overflow'
          )
        } else {
          try {
            if (progressDecoder) {
              options.onOutput?.(
                progressDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
              )
            }
            if (options.completeOutput?.()) {
              resolve(output.text())
            } else if (partialTimer === undefined && options.partialOutput?.ready(output.text())) {
              partialTimer = setTimeout(
                () => resolve(output.text()),
                options.partialOutput.timeoutMs
              )
            }
          } catch (error) {
            reject(error)
          }
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
    clearTimeout(partialTimer)
    options.signal?.removeEventListener('abort', onAbort)
    await managed.close()
  }
}

function throwIfStopped(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) {
    throw new AgentModelCatalogProbeError(`${label} listing stopped`, 'stopped')
  }
}

export function isAgentModelCatalogWorkTimeout(signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true &&
    signal.reason instanceof AgentModelCatalogProbeError &&
    signal.reason.reason === 'timeout'
  )
}

export type AgentModelCatalogReady<T> = (cleanup: () => Promise<unknown>, partial?: () => T) => void

export type AgentModelCatalogProbeConnection = { close(): Promise<unknown> }

export async function runAgentModelCatalogSession<C extends AgentModelCatalogProbeConnection, T>(
  open: () => C,
  body: (connection: C, ready: AgentModelCatalogReady<T>) => Promise<T>,
  options: { label: string; timeoutMs?: number | null; signal?: AbortSignal }
): Promise<T> {
  const timeoutMs =
    options.timeoutMs === undefined ? AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS : options.timeoutMs
  throwIfStopped(options.signal, options.label)
  const connection = open()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cleanup: (() => Promise<unknown>) | undefined
  let partial: (() => T) | undefined
  let settled = false
  const ready: AgentModelCatalogReady<T> = (closeSession, readPartial) => {
    if (!settled) {
      cleanup = closeSession
      partial = readPartial
    }
  }
  let onAbort = (): void => {}
  const deadline = new Promise<T>((resolve, reject) => {
    const expire = (): void => {
      settled = true
      if (partial) {
        resolve(partial())
      } else {
        reject(new AgentModelCatalogProbeError(`${options.label} listing timed out`, 'timeout'))
      }
    }
    onAbort = () => {
      if (isAgentModelCatalogWorkTimeout(options.signal)) {
        expire()
      } else {
        reject(new AgentModelCatalogProbeError(`${options.label} listing stopped`, 'stopped'))
      }
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timer = timeoutMs === null ? undefined : setTimeout(expire, timeoutMs)
  })
  try {
    return await Promise.race([body(connection, ready), deadline])
  } finally {
    settled = true
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    if (cleanup) {
      await withTimeout(cleanup(), 1_000, undefined)
    }
    await connection.close().catch(() => undefined)
  }
}
