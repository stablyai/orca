import { getDefaultUserDataPath } from '../../src/cli/runtime/metadata'
import type { PairingOffer } from '../../src/shared/pairing'
import { RemoteRuntimeSharedControlConnection } from '../../src/shared/remote-runtime-shared-control-connection'
import {
  resolveEnvironment,
  resolveEnvironmentPairingOffer
} from '../../src/shared/runtime-environment-store'
import type { MemorySnapshot } from '../../src/shared/process-stats-types'
import type { RuntimeStatus } from '../../src/shared/runtime-types'

async function main(): Promise<void> {
  const environmentName = process.env.ORCA_PROBE_ENVIRONMENT_NAME
  if (!environmentName) {
    throw new Error('ORCA_PROBE_ENVIRONMENT_NAME is required')
  }
  const userDataPath = getDefaultUserDataPath()
  const environment = resolveEnvironment(userDataPath, environmentName)
  const pairing = resolveEnvironmentPairingOffer(userDataPath, environment.id)
  const cycles = readProbeInteger('ORCA_PROBE_CYCLES', 10, 100)
  const concurrency = readProbeInteger('ORCA_PROBE_CONCURRENCY', 25, 200)
  const settleMs = readProbeInteger('ORCA_PROBE_SETTLE_MS', 250, 5_000)
  const cleanupTimeoutMs = readProbeInteger('ORCA_PROBE_CLEANUP_TIMEOUT_MS', 10_000, 30_000)
  const unknownResponses = new Map<string, number>()
  const originalWarn = console.warn
  console.warn = (message?: unknown, details?: unknown): void => {
    if (
      message === '[remote-runtime.shared-control] unknown response id' &&
      typeof details === 'object' &&
      details !== null
    ) {
      const responseId = String((details as { responseId?: unknown }).responseId ?? 'unknown')
      unknownResponses.set(responseId, (unknownResponses.get(responseId) ?? 0) + 1)
      return
    }
    originalWarn(message, details)
  }
  try {
    const startedAt = Date.now()
    const before = await requestMemorySnapshot(pairing, environment.id)
    let ok = 0
    let subscriptionResponses = 0
    let runtimeStatus: RuntimeStatus | null = null
    const cleanupDurationsMs: number[] = []
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const result = await runCycle({
        pairing,
        environmentId: environment.id,
        concurrency,
        settleMs,
        cleanupTimeoutMs
      })
      ok += result.ok
      subscriptionResponses += result.subscriptionResponses
      runtimeStatus ??= result.runtimeStatus
      cleanupDurationsMs.push(result.cleanupDurationMs)
    }
    await wait(settleMs)
    const after = await requestMemorySnapshot(pairing, environment.id)
    console.log(
      JSON.stringify({
        environment: { id: environment.id, name: environment.name },
        runtime: runtimeStatus
          ? {
              appVersion: runtimeStatus.appVersion ?? null,
              capabilities: runtimeStatus.capabilities ?? [],
              hostPlatform: runtimeStatus.hostPlatform ?? null
            }
          : null,
        cycles,
        concurrency,
        requests: cycles * concurrency,
        ok,
        subscriptionResponses,
        cleanupDurationMs: {
          average: Math.round(
            cleanupDurationsMs.reduce((total, duration) => total + duration, 0) /
              cleanupDurationsMs.length
          ),
          maximum: Math.max(...cleanupDurationsMs)
        },
        unknownResponseFrames: Array.from(unknownResponses.values()).reduce(
          (total, count) => total + count,
          0
        ),
        unknownResponseIds: unknownResponses.size,
        memory: {
          before: summarizeMemory(before),
          after: summarizeMemory(after),
          appDelta: after.app.memory - before.app.memory
        },
        elapsedMs: Date.now() - startedAt
      })
    )
  } finally {
    console.warn = originalWarn
  }
}

async function runCycle(args: {
  pairing: PairingOffer
  environmentId: string
  concurrency: number
  settleMs: number
  cleanupTimeoutMs: number
}): Promise<{
  ok: number
  subscriptionResponses: number
  cleanupDurationMs: number
  runtimeStatus: RuntimeStatus | null
}> {
  const connection = new RemoteRuntimeSharedControlConnection(args.pairing, {
    environmentId: args.environmentId
  })
  try {
    const responses = await Promise.all(
      Array.from({ length: args.concurrency }, () =>
        connection.request<RuntimeStatus>('status.get', undefined, 10_000)
      )
    )
    const runtimeStatus = responses.find((response) => response.ok)
    let subscriptionResponses = 0
    const subscriptions = await Promise.all([
      connection.subscribe('runtime.clientEvents.subscribe', undefined, 10_000, {
        onResponse: () => {
          subscriptionResponses += 1
        },
        onError: () => {}
      }),
      connection.subscribe('session.tabs.subscribeAll', undefined, 10_000, {
        onResponse: () => {
          subscriptionResponses += 1
        },
        onError: () => {}
      })
    ])
    await wait(args.settleMs)
    for (const subscription of subscriptions) {
      subscription.close()
    }
    const cleanupDurationMs = await waitForConnectionIdle(connection, args.cleanupTimeoutMs)
    // Let cleanup replies reach the retirement cache before closing the socket.
    await wait(args.settleMs)
    return {
      ok: responses.filter((response) => response.ok).length,
      subscriptionResponses,
      cleanupDurationMs,
      runtimeStatus: runtimeStatus?.ok === true ? runtimeStatus.result : null
    }
  } finally {
    connection.close()
  }
}

async function waitForConnectionIdle(
  connection: RemoteRuntimeSharedControlConnection,
  timeoutMs: number
): Promise<number> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const diagnostics = connection.getDiagnostics()
    if (diagnostics.pendingRequestCount === 0 && diagnostics.subscriptionCount === 0) {
      return Date.now() - startedAt
    }
    await wait(25)
  }
  throw new Error(`Cycle did not settle: ${JSON.stringify(connection.getDiagnostics())}`)
}

async function requestMemorySnapshot(
  pairing: PairingOffer,
  environmentId: string
): Promise<MemorySnapshot> {
  const connection = new RemoteRuntimeSharedControlConnection(pairing, { environmentId })
  try {
    const response = await connection.request<MemorySnapshot>(
      'diagnostics.memory',
      undefined,
      20_000
    )
    if (!response.ok) {
      throw new Error(`Memory snapshot failed: ${response.error.message}`)
    }
    return response.result
  } finally {
    connection.close()
  }
}

function summarizeMemory(snapshot: MemorySnapshot): {
  app: MemorySnapshot['app']
  host: MemorySnapshot['host']
  processMemoryMetric: MemorySnapshot['processMemoryMetric']
  processCommitMetric: MemorySnapshot['processCommitMetric']
  totalCpu: number
  totalMemory: number
  totalPrivateMemory: MemorySnapshot['totalPrivateMemory']
  worktreeCount: number
  sessionCount: number
  worktreeMemory: number
  topWorktrees: {
    worktreeName: string
    repoName: string
    cpu: number
    memory: number
    sessionCount: number
    topSessions: { pid: number; cpu: number; memory: number }[]
  }[]
} {
  return {
    app: snapshot.app,
    host: snapshot.host,
    processMemoryMetric: snapshot.processMemoryMetric,
    processCommitMetric: snapshot.processCommitMetric,
    totalCpu: snapshot.totalCpu,
    totalMemory: snapshot.totalMemory,
    totalPrivateMemory: snapshot.totalPrivateMemory,
    worktreeCount: snapshot.worktrees.length,
    sessionCount: snapshot.worktrees.reduce(
      (total, worktree) => total + worktree.sessions.length,
      0
    ),
    worktreeMemory: snapshot.worktrees.reduce((total, worktree) => total + worktree.memory, 0),
    topWorktrees: [...snapshot.worktrees]
      .sort((left, right) => right.memory - left.memory)
      .slice(0, 10)
      .map((worktree) => ({
        worktreeName: worktree.worktreeName,
        repoName: worktree.repoName,
        cpu: worktree.cpu,
        memory: worktree.memory,
        sessionCount: worktree.sessions.length,
        topSessions: [...worktree.sessions]
          .sort((left, right) => right.memory - left.memory)
          .slice(0, 5)
          .map((session) => ({
            pid: session.pid,
            cpu: session.cpu,
            memory: session.memory
          }))
      }))
  }
}

function readProbeInteger(name: string, fallback: number, maximum: number): number {
  const value = process.env[name]
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`)
  }
  return parsed
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
