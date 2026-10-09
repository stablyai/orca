// The one way a catalog probe runs an agent CLI: a disposable child under the provider supervisor,
// one budget for the whole listing, bounded output, and a teardown awaited on every path. A probe
// only names what to run and how to read its answer.

import { createOutputSink } from '../../../shared/child-process/bounded-output-sink'
import type { spawnProcess } from '../../../shared/child-process/run-process'
import { spawnManagedProviderProcess } from '../../provider-process/managed-provider-process'
import type { ProviderProcessClosePolicy } from '../../provider-process/provider-process-close'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../provider-process/provider-process-supervisor'
import {
  providerStderrForDisplay,
  supervisedProviderSpawnFailure
} from '../../provider-process/provider-spawn-failure-report'

// Why 15s: a cold listing may pay one network fetch; past that, the picker keeps what it has.
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
    /** The listing's own executable was not found, as the spawn or its supervisor reported. */
    readonly executableMissing = false
  ) {
    super(message)
    this.name = 'AgentModelCatalogProbeError'
  }
}

/** Nothing waits on a probe past its answer, so a close stops it at once rather than draining. */
function probeClosePolicy(supervised: boolean): ProviderProcessClosePolicy {
  return {
    gracefulExitMs: supervised ? PROVIDER_SUPERVISOR_MAX_STOP_MS : UNSUPERVISED_GRACEFUL_EXIT_MS,
    forcedExitMs: FORCED_EXIT_MS,
    signalSupervisorOnClose: true
  }
}

export type AgentModelCatalogListingLaunch = ProviderProcessLaunch & {
  /** Written then closed; a listing that reads no request gets an immediately closed stdin. */
  stdin?: string
}

export type AgentModelCatalogRunnerOptions = {
  site: string
  timeoutMs?: number
  maxOutputBytes?: number
  /** Stops the listing and its child, as the deadline would. */
  signal?: AbortSignal
  /** Test seams. */
  spawnImpl?: typeof spawnProcess
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
}

/** Runs a listing command to its exit and answers its stdout; any exit but 0, an overflow or the
 *  deadline rejects. The child is stopped and awaited before this settles either way. */
export async function runAgentModelCatalogListing(
  launch: AgentModelCatalogListingLaunch,
  options: AgentModelCatalogRunnerOptions
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS
  throwIfStopped(options.signal, launch.command)
  const managed = spawnManagedProviderProcess(launch, {
    site: options.site,
    // A listing's stdin end is the end of its request, not a stop.
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
      const fail = (message: string, reason: AgentModelCatalogProbeFailure): void =>
        reject(
          new AgentModelCatalogProbeError(
            message,
            reason,
            reason === 'spawn' && managed.executableMissing
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
      // `close`, not `exit`: only then has every byte of stdout arrived.
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
            'exit'
          )
        }
      })
      try {
        child.stdin.end(launch.stdin ?? '')
      } catch {
        // A child that is already gone reports through `close`.
      }
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

/** A probe that holds a protocol connection rather than reading one command's output. */
export type AgentModelCatalogProbeConnection = { close(): Promise<unknown> }

/** Opens a disposable connection, runs `body` under the one probe budget, and always closes it. */
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
