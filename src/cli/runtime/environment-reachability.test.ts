import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lock } from 'proper-lockfile'
import { encodePairingOffer } from '../../shared/pairing'
import { RUNTIME_PROTOCOL_VERSION } from '../../shared/protocol-version'
import {
  createSharedControlTestServer,
  closeSharedControlTestServers
} from '../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  resolveEnvironment,
  updateEnvironmentFromPairingCode
} from '../../shared/runtime-environment-store'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { main } from '../index'
import {
  probeEnvironmentReachability,
  readEnvironmentReachability
} from './environment-reachability'

const directories: string[] = []
function temporaryProfile(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-reachability-'))
  directories.push(path)
  return path
}
function readyStatus(): RuntimeStatus {
  return {
    runtimeId: 'runtime-test',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION
  }
}
async function pairedServer(options: Parameters<typeof createSharedControlTestServer>[0] = {}) {
  const profile = temporaryProfile()
  const server = await createSharedControlTestServer({ resultForRequest: readyStatus, ...options })
  const environment = addEnvironmentFromPairingCode(profile, {
    name: 'build-server',
    pairingCode: encodePairingOffer(server.offer),
    now: 100
  })
  return { profile, server, environment }
}
function cacheFile(profile: string): string {
  const directory = join(profile, 'environment-reachability-v1')
  const filename = readdirSync(directory).find((name) => name.endsWith('.json'))
  if (!filename) {
    throw new Error('Missing reachability history')
  }
  return join(directory, filename)
}

afterEach(async () => {
  await closeSharedControlTestServers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('saved environment reachability', () => {
  it('probes the actual encrypted connection without rewriting the saved pairing or exposing credentials', async () => {
    const { profile, server, environment } = await pairedServer()
    const before = readFileSync(getEnvironmentStorePath(profile), 'utf8')
    expect(readEnvironmentReachability(profile, environment)).toEqual({
      status: 'unknown',
      checkedAt: null,
      lastSeenAt: null,
      failureCode: null
    })
    expect(server.connectionCount()).toBe(0)
    vi.spyOn(Date, 'now').mockReturnValue(1000)

    const observation = await probeEnvironmentReachability(profile, environment)

    expect(observation).toEqual({
      status: 'online',
      checkedAt: 1000,
      lastSeenAt: 1000,
      failureCode: null
    })
    expect(readEnvironmentReachability(profile, environment)).toEqual(observation)
    expect(server.requests.map((request) => request.method)).toEqual(['status.get'])
    expect(server.auths).toHaveLength(1)
    expect(readFileSync(getEnvironmentStorePath(profile), 'utf8')).toBe(before)
    const history = readFileSync(cacheFile(profile), 'utf8')
    expect(history).not.toContain(server.offer.deviceToken)
    expect(history).not.toContain(server.offer.publicKeyB64)
  })

  it('retains the last verified sighting when the same connection becomes unreachable', async () => {
    const { profile, server, environment } = await pairedServer()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    await probeEnvironmentReachability(profile, environment)
    server.closeClients()
    await closeSharedControlTestServers()
    clock.mockReturnValue(2000)
    const failed = await probeEnvironmentReachability(profile, environment)
    expect(failed).toMatchObject({ status: 'unreachable', checkedAt: 2000, lastSeenAt: 1000 })
    expect(readEnvironmentReachability(profile, environment)).toEqual(failed)
  })

  it.each(['unauthorized', 'incompatible'] as const)(
    'distinguishes %s from an offline machine',
    async (kind) => {
      const { profile, environment } = await pairedServer(
        kind === 'unauthorized'
          ? { rejectAuth: true }
          : { resultForRequest: () => ({ ...readyStatus(), runtimeProtocolVersion: 0 }) }
      )
      const result = await probeEnvironmentReachability(profile, environment)
      expect(result).toMatchObject({
        status: 'blocked',
        lastSeenAt: null,
        failureCode: kind === 'unauthorized' ? 'unauthorized' : 'incompatible_runtime'
      })
    }
  )

  it('invalidates observations after re-pairing and never applies an old in-flight identity to the new pairing', async () => {
    const admitted = Promise.withResolvers<void>()
    const { profile, server, environment } = await pairedServer({
      delayedMethods: ['status.get'],
      resultForRequest: () => {
        admitted.resolve()
        return readyStatus()
      }
    })
    const second = await createSharedControlTestServer({ resultForRequest: readyStatus })
    const pending = probeEnvironmentReachability(profile, environment)
    await admitted.promise
    const replacement = updateEnvironmentFromPairingCode(profile, environment.id, {
      pairingCode: encodePairingOffer(second.offer),
      now: 200,
      runtimeId: 'new-runtime'
    })
    server.flushDelayedResponses()
    expect(await pending).toMatchObject({
      status: 'unknown',
      failureCode: 'environment_changed',
      lastSeenAt: null
    })
    expect(resolveEnvironment(profile, environment.id).runtimeId).toBe('new-runtime')
    expect(readEnvironmentReachability(profile, replacement)).toMatchObject({
      status: 'unknown',
      checkedAt: null
    })
    expect(second.connectionCount()).toBe(0)
  })

  it('does not label malformed status data as online', async () => {
    const { profile, environment } = await pairedServer({
      resultForRequest: () => ({
        ...readyStatus(),
        runtimeProtocolVersion: 'not-a-version'
      })
    })
    expect(await probeEnvironmentReachability(profile, environment)).toMatchObject({
      status: 'unknown',
      failureCode: 'invalid_runtime_response',
      lastSeenAt: null
    })
  })

  it('drops cached reachability when the pairing changes after a successful probe', async () => {
    const { profile, environment } = await pairedServer()
    await probeEnvironmentReachability(profile, environment)
    const second = await createSharedControlTestServer()
    const replacement = updateEnvironmentFromPairingCode(profile, environment.id, {
      pairingCode: encodePairingOffer(second.offer),
      now: 200
    })
    expect(readEnvironmentReachability(profile, replacement)).toMatchObject({
      status: 'unknown',
      checkedAt: null,
      lastSeenAt: null
    })
  })

  it('preserves a newer verdict while recording an older successful sighting', async () => {
    let requests = 0
    const { profile, server, environment } = await pairedServer({
      resultForRequest: () => ({
        ...readyStatus(),
        runtimeProtocolVersion: requests++ === 0 ? 0 : RUNTIME_PROTOCOL_VERSION
      })
    })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(3000)
    await probeEnvironmentReachability(profile, environment)
    clock.mockReturnValue(2500)
    expect(await probeEnvironmentReachability(profile, environment)).toMatchObject({
      status: 'online',
      lastSeenAt: 2500
    })
    expect(readEnvironmentReachability(profile, environment)).toEqual({
      status: 'blocked',
      checkedAt: 3000,
      lastSeenAt: 2500,
      failureCode: 'incompatible_runtime'
    })
    expect(server.requests).toHaveLength(2)
  })

  it('uses a total deadline even when the server completes the handshake then stalls', async () => {
    const admitted = Promise.withResolvers<void>()
    const { profile, environment } = await pairedServer({
      delayedMethods: ['status.get'],
      resultForRequest: () => {
        admitted.resolve()
        return readyStatus()
      }
    })
    const originalSetTimeout = globalThis.setTimeout
    let deadline: (() => void) | undefined
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 5000 && deadline === undefined) {
        deadline = () => callback(...args)
      }
      return originalSetTimeout(callback, delay, ...args)
    })
    const pending = probeEnvironmentReachability(profile, environment)
    await admitted.promise
    expect(deadline).toBeDefined()
    deadline?.()
    expect(await pending).toMatchObject({
      status: 'unreachable',
      failureCode: 'runtime_timeout',
      lastSeenAt: null
    })
  })

  it.each([0, -1, 0.5, 30001, Infinity])(
    'rejects an invalid timeout %s before dialing',
    async (timeout) => {
      const { profile, server, environment } = await pairedServer()
      await expect(
        probeEnvironmentReachability(profile, environment, timeout)
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(server.connectionCount()).toBe(0)
    }
  )

  it('treats damaged or oversized history as unknown and repairs it on an explicit probe', async () => {
    const { profile, environment } = await pairedServer()
    await probeEnvironmentReachability(profile, environment)
    const path = cacheFile(profile)
    writeFileSync(path, 'x'.repeat(9000))
    expect(readEnvironmentReachability(profile, environment)).toMatchObject({
      status: 'unknown',
      failureCode: 'cache_unavailable'
    })
    expect(await probeEnvironmentReachability(profile, environment)).toMatchObject({
      status: 'online'
    })
    expect(readEnvironmentReachability(profile, environment)).toMatchObject({ status: 'online' })
  })

  it('returns the actual probe with unsaved history when another process holds the cache lock', async () => {
    const { profile, environment } = await pairedServer()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    await probeEnvironmentReachability(profile, environment)
    const release = await lock(cacheFile(profile), { realpath: false, retries: 0 })
    const originalSetTimeout = globalThis.setTimeout
    const retryScheduled = Promise.withResolvers<'cache-retry'>()
    const timers: ReturnType<typeof setTimeout>[] = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      const timer = originalSetTimeout(callback, delay, ...args)
      if (delay !== undefined && delay > 0 && delay < 5000) {
        timers.push(timer)
        retryScheduled.resolve('cache-retry')
      }
      return timer
    })
    try {
      clock.mockReturnValue(2000)
      expect(
        await Promise.race([
          probeEnvironmentReachability(profile, environment),
          retryScheduled.promise
        ])
      ).toEqual({
        status: 'online',
        checkedAt: 2000,
        lastSeenAt: 2000,
        failureCode: null,
        historySaved: false
      })
      expect(readEnvironmentReachability(profile, environment).checkedAt).toBe(1000)
    } finally {
      for (const timer of timers) {
        clearTimeout(timer)
      }
      await release()
    }
  })

  it('keeps observations for separate environments when probes complete concurrently', async () => {
    const { profile, server, environment } = await pairedServer()
    const second = await createSharedControlTestServer({ resultForRequest: readyStatus })
    const other = addEnvironmentFromPairingCode(profile, {
      name: 'second-server',
      pairingCode: encodePairingOffer(second.offer),
      now: 200
    })
    await Promise.all([
      probeEnvironmentReachability(profile, environment),
      probeEnvironmentReachability(profile, other)
    ])
    expect(readEnvironmentReachability(profile, environment).status).toBe('online')
    expect(readEnvironmentReachability(profile, other).status).toBe('online')
    expect(server.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
  })

  it('reports actual probe results through the public CLI and keeps list/show cache-only by default', async () => {
    const { profile, server, environment } = await pairedServer()
    vi.stubEnv('ORCA_USER_DATA_PATH', profile)
    vi.stubEnv('ORCA_ENVIRONMENT', 'stale-environment')
    vi.stubEnv('ORCA_PAIRING_CODE', 'invalid-unused-pairing')
    vi.stubEnv('ORCA_REMOTE_PAIRING', 'invalid-unused-pairing')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      ['environment', 'show', '--environment', environment.id, '--probe', '--json'],
      '/tmp'
    )
    expect(log.mock.calls.at(-1)?.[0]).toContain('"status": "online"')
    expect(log.mock.calls.at(-1)?.[0]).not.toContain(server.offer.deviceToken)
    expect(log.mock.calls.at(-1)?.[0]).not.toContain(server.offer.publicKeyB64)
    await main(['environment', 'list', '--json'], '/tmp')
    expect(log.mock.calls.at(-1)?.[0]).toContain('"lastSeenAt":')
    await main(['environment', 'show', '--environment', environment.id], '/tmp')
    expect(log.mock.calls.at(-1)?.[0]).toContain('lastProbe: online')
    expect(server.requests).toHaveLength(1)
    const exitCode = process.exitCode
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await main(
        ['environment', 'show', '--environment', environment.id, '--timeout-ms', '10'],
        '/tmp'
      )
      expect(process.exitCode).toBe(1)
      expect(errorLog.mock.calls.at(-1)?.[0]).toContain('--timeout-ms requires --probe')
    } finally {
      process.exitCode = exitCode
    }
    expect(server.requests).toHaveLength(1)
  })
})
