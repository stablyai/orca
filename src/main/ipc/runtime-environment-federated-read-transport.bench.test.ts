import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { RemoteRuntimeSharedControlConnection } from '../../shared/remote-runtime-shared-control-connection'
import { RuntimeEnvironmentStoreSchema } from '../../shared/runtime-environments'

const runLiveBenchmark = isFederatedReadBenchmarkEnabled(process.env.ORCA_FEDERATED_READ_BENCH)

it('interpolates even-sized benchmark samples', () => expect(percentile([1, 3], 0.5)).toBe(2))

it.each([
  ['1', true],
  ['true', false],
  [undefined, false]
])('enables the live benchmark only for %s', (value, enabled) => {
  expect(isFederatedReadBenchmarkEnabled(value)).toBe(enabled)
})

it('closes the retained connection after a measured request rejects', async () => {
  let requestCount = 0
  const fixture = createSharedControlFixture(async () => {
    requestCount += 1
    if (requestCount === 4) {
      throw new Error('injected measured request failure')
    }
    return { ok: true }
  })

  await expect(measureSharedControlRequests(fixture.connection, {}, 1)).rejects.toThrow(
    'injected measured request failure'
  )

  expect(requestCount).toBe(4)
  expect.soft(fixture.close).toHaveBeenCalledOnce()
  expect.soft(fixture.socketClose).toHaveBeenCalledOnce()
  expect(fixture.retainedHandleCount()).toBe(0)
})

it('closes the retained connection after successful measurements', async () => {
  const fixture = createSharedControlFixture(async () => ({ ok: true }))

  await expect(measureSharedControlRequests(fixture.connection, {}, 1)).resolves.toMatchObject({
    sharedControl: { count: 1 },
    diagnostics: { state: 'ready', pendingRequestCount: 0 }
  })

  expect(fixture.close).toHaveBeenCalledOnce()
  expect(fixture.socketClose).toHaveBeenCalledOnce()
  expect(fixture.retainedHandleCount()).toBe(0)
})

describe.runIf(runLiveBenchmark)('federated read RPC transport benchmark', () => {
  it('compares one-shot and shared-control latency on one saved runtime', async () => {
    const userDataPath = process.env.ORCA_RUNTIME_USER_DATA_PATH
    const environmentName = process.env.ORCA_RUNTIME_ENVIRONMENT
    if (!userDataPath || !environmentName) {
      throw new Error('Set ORCA_RUNTIME_USER_DATA_PATH and ORCA_RUNTIME_ENVIRONMENT.')
    }
    const store = RuntimeEnvironmentStoreSchema.parse(
      JSON.parse(readFileSync(join(userDataPath, 'orca-environments.json'), 'utf8'))
    )
    const environment = store.environments.find((entry) => entry.name === environmentName)
    if (!environment) {
      throw new Error(`Unknown runtime environment: ${environmentName}`)
    }
    const endpoint =
      environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
      environment.endpoints[0]
    if (!endpoint) {
      throw new Error(`Runtime environment ${environmentName} has no endpoint.`)
    }
    const pairing = {
      v: 2 as const,
      endpoint: endpoint.endpoint,
      deviceToken: endpoint.deviceToken,
      publicKeyB64: endpoint.publicKeyB64
    }
    const params = {
      dispatchId: 'sta3880_benchmark_missing',
      afterSequence: 0,
      limit: 50
    }
    const oneShot = await measureRequests(() =>
      sendRemoteRuntimeRequest(pairing, 'orchestration.federationPull', params, 15_000, {
        orchestrationContractVersion: 1
      })
    )
    const shared = new RemoteRuntimeSharedControlConnection(pairing, {
      environmentId: environment.id
    })
    const { sharedControl, diagnostics } = await measureSharedControlRequests(shared, params)

    expect(diagnostics).toMatchObject({ state: 'ready', pendingRequestCount: 0 })
    process.stdout.write(`${JSON.stringify({ oneShot, sharedControl }, null, 2)}\n`)
  }, 120_000)
})

async function measureSharedControlRequests(
  shared: RemoteRuntimeSharedControlConnection,
  params: unknown,
  count = 30
): Promise<{
  sharedControl: Awaited<ReturnType<typeof measureRequests>>
  diagnostics: ReturnType<RemoteRuntimeSharedControlConnection['getDiagnostics']>
}> {
  try {
    const sharedControl = await measureRequests(
      () =>
        shared.request('orchestration.federationPull', params, 15_000, {
          orchestrationContractVersion: 1
        }),
      count
    )
    const diagnostics = shared.getDiagnostics()
    return { sharedControl, diagnostics }
  } finally {
    shared.close()
  }
}

async function measureRequests(
  request: () => Promise<{ ok: boolean; error?: { code: string } }>,
  count = 30
): Promise<{
  count: number
  meanMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
  responseCodes: string[]
}> {
  for (let index = 0; index < 3; index++) {
    await request()
  }
  const durations: number[] = []
  const responseCodes = new Set<string>()
  for (let index = 0; index < count; index++) {
    const startedAt = performance.now()
    const response = await request()
    durations.push(performance.now() - startedAt)
    if (!response.ok && response.error) {
      responseCodes.add(response.error.code)
    }
  }
  durations.sort((left, right) => left - right)
  return {
    count,
    meanMs: round(durations.reduce((sum, value) => sum + value, 0) / count),
    medianMs: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    minMs: round(durations[0] ?? 0),
    maxMs: round(durations.at(-1) ?? 0),
    responseCodes: [...responseCodes]
  }
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const rank = (sorted.length - 1) * fraction
  const lowerIndex = Math.floor(rank)
  const upperIndex = Math.ceil(rank)
  const lower = sorted[lowerIndex] ?? 0
  const upper = sorted[upperIndex] ?? lower
  return lower + (upper - lower) * (rank - lowerIndex)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function isFederatedReadBenchmarkEnabled(value: string | undefined): boolean {
  return value === '1'
}

function createSharedControlFixture(
  request: () => Promise<{ ok: boolean; error?: { code: string } }>
): {
  connection: RemoteRuntimeSharedControlConnection
  close: ReturnType<typeof vi.fn>
  socketClose: ReturnType<typeof vi.fn>
  retainedHandleCount: () => number
} {
  const connection = new RemoteRuntimeSharedControlConnection({
    v: 2,
    endpoint: 'ws://127.0.0.1:1',
    deviceToken: 'token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
  const socketClose = vi.fn()
  const unsafe = connection as unknown as {
    state: string
    ws: { readyState: number; close: () => void } | null
    sharedKey: Uint8Array | null
    request: typeof request
  }
  unsafe.state = 'ready'
  unsafe.ws = { readyState: 1, close: socketClose }
  unsafe.sharedKey = new Uint8Array(32).fill(2)
  unsafe.request = vi.fn(request)
  const close = vi.spyOn(connection, 'close')
  return { connection, close, socketClose, retainedHandleCount: () => (unsafe.ws ? 1 : 0) }
}
