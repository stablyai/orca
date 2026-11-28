import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  execSecurityCommand,
  readKeychainPassword,
  readKeychainPasswordResult
} from './generic-password'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
// A test must never reach the real keychain.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(() => {
    throw new Error('security must run through the process runner')
  })
}))

type ProcessSpec = Parameters<typeof runProcess>[0]
/** How one `security` run behaves: answers `afterMs` after it starts, or hangs past its limit and
 *  is reaped `reapMs` after that (a child that ignored SIGTERM until SIGKILL). */
type Behaviour = { afterMs: number; stdout?: string; code?: number; reapMs?: number }

const spawned: { at: number; spec: ProcessSpec; reapedAt?: number }[] = []

/** Each `security` run behaves as the next of `behaviours`; the last repeats. */
function security(...behaviours: Behaviour[]): void {
  vi.mocked(runProcess).mockImplementation((spec: ProcessSpec) => {
    const behaviour = behaviours[Math.min(spawned.length, behaviours.length - 1)]
    const run: (typeof spawned)[number] = { at: Date.now(), spec }
    spawned.push(run)
    const limit = spec.timeoutMs ?? Number.POSITIVE_INFINITY
    return new Promise((resolve) => {
      if (behaviour.afterMs <= limit) {
        setTimeout(() => {
          run.reapedAt = Date.now()
          spec.onChildTerminated?.()
          resolve({
            code: behaviour.code ?? 0,
            signal: null,
            stdout: behaviour.code ? '' : `${behaviour.stdout ?? 'secret'}\n`,
            stderr: '',
            timedOut: false
          })
        }, behaviour.afterMs)
        return
      }
      // Timed out: the runner escalates to SIGKILL and settles once the child is gone.
      setTimeout(
        () => {
          run.reapedAt = Date.now()
          spec.onChildTerminated?.()
          resolve({ code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true })
        },
        limit + (behaviour.reapMs ?? 0)
      )
    })
  })
}

// Each test reads its own item, so no flight or remembered state crosses tests.
let item = 0
const nextService = () => `orca-test-service-${++item}`

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-11-27T21:56:29Z') })
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.mocked(runProcess).mockReset()
  spawned.length = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )

it('runs /usr/bin/security through the process runner with a termination barrier', async () => {
  security({ afterMs: 10, stdout: 'token' })
  const read = readKeychainPassword(nextService(), 'user')
  await vi.advanceTimersByTimeAsync(100)
  expect(await read).toBe('token')
  expect(spawned[0].spec).toMatchObject({ program: '/usr/bin/security' })
  expect(spawned[0].spec.terminationBarrier).toBeTruthy()
})

// Incident replay: under host load `security` took ~6 s; the 3 s limit turned a signed-in login
// into a failed read.
it('lets a background caller wait out a 6 s keychain read', async () => {
  security({ afterMs: 6_000, stdout: 'token' })
  const read = settle(readKeychainPassword(nextService(), 'user', { caller: 'background' }))
  await vi.advanceTimersByTimeAsync(6_500)
  expect(await read).toEqual({ value: 'token' })
})

it('gives a foreground caller one 6 s deadline in all, retrying once only after the first child is reaped', async () => {
  // The first child ignores SIGTERM for 500 ms; the retry answers in time.
  security({ afterMs: 60_000, reapMs: 500 }, { afterMs: 1_000, stdout: 'token' })
  const started = Date.now()
  const read = settle(readKeychainPassword(nextService(), 'user'))
  await vi.advanceTimersByTimeAsync(6_000)
  expect(await read).toEqual({ value: 'token' })
  expect(spawned).toHaveLength(2)
  // Never a second child while the first is alive.
  expect(spawned[1].at).toBeGreaterThanOrEqual(spawned[0].reapedAt!)
  // The retry only gets what is left of the same deadline.
  expect(spawned[1].at - started + (spawned[1].spec.timeoutMs ?? 0)).toBeLessThanOrEqual(6_000)
})

it('never takes longer than its deadline when both attempts hang', async () => {
  security({ afterMs: 60_000, reapMs: 200 })
  const started = Date.now()
  let settledAt = 0
  const read = readKeychainPasswordResult(nextService(), 'user').then((result) => {
    settledAt = Date.now()
    return result
  })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(await read).toMatchObject({ status: 'unknown', reason: 'timeout' })
  expect(settledAt - started).toBeLessThanOrEqual(6_000)
  expect(spawned.length).toBeLessThanOrEqual(2)
})

it('never retries a definitive "item not found" answer', async () => {
  security({ afterMs: 10, code: 44 })
  const read = readKeychainPassword(nextService(), 'user')
  await vi.advanceTimersByTimeAsync(100)
  expect(await read).toBeNull()
  expect(spawned).toHaveLength(1)
})

it('never retries a locked keychain (36) or a denied one, and reports them as unknown', async () => {
  for (const [code, reason] of [
    [36, 'locked'],
    [51, 'denied']
  ] as const) {
    spawned.length = 0
    security({ afterMs: 10, code })
    const read = readKeychainPasswordResult(nextService(), 'user')
    await vi.advanceTimersByTimeAsync(100)
    expect(await read).toMatchObject({ status: 'unknown', reason })
    expect(spawned).toHaveLength(1)
  }
})

it('runs one `security` for many concurrent readers of one caller class, and keeps classes apart', async () => {
  security({ afterMs: 500, stdout: 'token' })
  const service = nextService()
  const background = Array.from({ length: 24 }, () =>
    readKeychainPassword(service, 'user', { caller: 'background' })
  )
  const foreground = readKeychainPassword(service, 'user')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(await Promise.all(background)).toEqual(Array(24).fill('token'))
  expect(await foreground).toBe('token')
  // One child for the 24 background readers, one for the foreground reader.
  expect(spawned).toHaveLength(2)
})

it('reports a read that never answered as unknown, with presence-only last-known-good and no stored negative', async () => {
  const service = nextService()
  security({ afterMs: 10, stdout: 'token' })
  const first = readKeychainPasswordResult(service, 'user')
  await vi.advanceTimersByTimeAsync(100)
  expect(await first).toMatchObject({ status: 'found', value: 'token' })

  security({ afterMs: 60_000 })
  const failed = readKeychainPasswordResult(service, 'user')
  await vi.advanceTimersByTimeAsync(20_000)
  const result = await failed
  expect(result).toMatchObject({ status: 'unknown', reason: 'timeout' })
  expect(result).toHaveProperty('lastKnownPresentAt')
  expect(JSON.stringify(result)).not.toContain('token')

  // The failure is not remembered as "absent": the next read asks again and finds it.
  security({ afterMs: 10, stdout: 'token' })
  const again = readKeychainPasswordResult(service, 'user')
  await vi.advanceTimersByTimeAsync(100)
  expect(await again).toMatchObject({ status: 'found', value: 'token' })
})

it('does not let a read that began before a delete publish last-known-good', async () => {
  const service = nextService()
  security({ afterMs: 1_000, stdout: 'token' }, { afterMs: 10 }, { afterMs: 60_000 })
  const before = readKeychainPasswordResult(service, 'user', { caller: 'background' })
  await vi.advanceTimersByTimeAsync(100)
  const deleted = execSecurityCommand(['delete-generic-password', '-s', service, '-a', 'user'])
  await vi.advanceTimersByTimeAsync(2_000)
  await deleted
  await before
  const later = readKeychainPasswordResult(service, 'user')
  await vi.advanceTimersByTimeAsync(20_000)
  const result = await later
  expect(result).toMatchObject({ status: 'unknown' })
  expect(result).not.toHaveProperty('lastKnownPresentAt')
})

it('logs the load average and concurrent agent starts when a keychain read times out', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  security({ afterMs: 60_000 })
  const read = readKeychainPasswordResult(nextService(), 'user')
  await vi.advanceTimersByTimeAsync(20_000)
  await read
  const logged = warn.mock.calls.find((call) => String(call[0]).includes('[agent-readiness]'))
  expect(logged?.[1]).toMatchObject({
    what: 'keychain',
    loadAverage: expect.any(Array),
    agentStartsInFlight: expect.any(Number)
  })
})
