import { execFile } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readKeychainPassword, readKeychainPasswordResult } from './generic-password'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void
type Answer = { afterMs: number; stdout?: string; exitCode?: number }

/** Each `security` run answers with the next of `answers`, `afterMs` after it starts. */
function securityAnswers(...answers: Answer[]): void {
  let next = 0
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    _args: string[],
    _options: unknown,
    callback: ExecCallback
  ) => {
    const answer = answers[Math.min(next, answers.length - 1)]
    next += 1
    const timer = setTimeout(() => {
      if (answer.exitCode !== undefined && answer.exitCode !== 0) {
        callback(
          Object.assign(new Error('security failed'), { code: answer.exitCode }),
          '',
          answer.exitCode === 44
            ? 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'
            : ''
        )
        return
      }
      callback(null, `${answer.stdout ?? 'secret'}\n`, '')
    }, answer.afterMs)
    return { kill: vi.fn(() => clearTimeout(timer)) }
  }) as unknown as typeof execFile)
}

// Each test reads its own item, so no single-flight or remembered state crosses tests.
let item = 0
const nextService = () => `orca-test-service-${++item}`

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.mocked(execFile).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Incident replay: under host load `security` took ~6 s; the 3 s limit turned a signed-in login
// into a failed read.
it('lets a background caller wait out a 6 s keychain read instead of failing at 3 s', async () => {
  securityAnswers({ afterMs: 6_000, stdout: 'token' })
  const read = readKeychainPassword(nextService(), 'user', { caller: 'background' })
  const settled = read.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  await vi.advanceTimersByTimeAsync(6_500)
  expect(await settled).toEqual({ value: 'token' })
})

it('retries a timed-out foreground read once before giving up', async () => {
  securityAnswers({ afterMs: 60_000 }, { afterMs: 100, stdout: 'token' })
  const service = nextService()
  const read = readKeychainPassword(service, 'user').then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await read).toEqual({ value: 'token' })
  expect(execFile).toHaveBeenCalledTimes(2)
})

it('never retries a definitive "item not found" answer', async () => {
  securityAnswers({ afterMs: 10, exitCode: 44 })
  const read = readKeychainPassword(nextService(), 'user')
  await vi.advanceTimersByTimeAsync(100)
  expect(await read).toBeNull()
  expect(execFile).toHaveBeenCalledTimes(1)
})

it('runs one `security` for many concurrent readers of the same item', async () => {
  securityAnswers({ afterMs: 500, stdout: 'token' })
  const service = nextService()
  const reads = Array.from({ length: 24 }, () =>
    readKeychainPassword(service, 'user', { caller: 'background' })
  )
  await vi.advanceTimersByTimeAsync(1_000)
  expect(await Promise.all(reads)).toEqual(Array(24).fill('token'))
  expect(execFile).toHaveBeenCalledTimes(1)
})

it('reports a read that never answered as unknown, and stores no negative from it', async () => {
  const service = nextService()
  securityAnswers({ afterMs: 10, stdout: 'token' })
  const first = readKeychainPasswordResult(service, 'user')
  await vi.advanceTimersByTimeAsync(100)
  expect(await first).toMatchObject({ status: 'found', value: 'token' })

  // Both attempts of the next read hang past the foreground limit.
  securityAnswers({ afterMs: 60_000 })
  const failed = readKeychainPasswordResult(service, 'user')
  await vi.advanceTimersByTimeAsync(10_000)
  const result = await failed
  expect(result).toMatchObject({ status: 'unknown', reason: 'timeout' })
  // Last-known-good is presence and time only: never the secret.
  expect(result).toHaveProperty('lastKnownPresentAt')
  expect(JSON.stringify(result)).not.toContain('token')

  // The failure is not remembered as "absent": the next read asks again and finds it.
  securityAnswers({ afterMs: 10, stdout: 'token' })
  const again = readKeychainPasswordResult(service, 'user')
  await vi.advanceTimersByTimeAsync(100)
  expect(await again).toMatchObject({ status: 'found', value: 'token' })
})

it('logs the load average and concurrent agent starts when a keychain read times out', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  securityAnswers({ afterMs: 60_000 })
  const read = readKeychainPasswordResult(nextService(), 'user')
  await vi.advanceTimersByTimeAsync(10_000)
  await read
  const logged = warn.mock.calls.find((call) => String(call[0]).includes('[agent-readiness]'))
  expect(logged).toBeDefined()
  expect(logged?.[1]).toMatchObject({
    what: 'keychain',
    loadAverage: expect.any(Array),
    agentStartsInFlight: expect.any(Number)
  })
})
