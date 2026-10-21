import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { openRelayDatabaseAtBoot } from './boot-database-open.js'
import type { RelayDatabase } from './database.js'

const input = { dataDir: '/tmp/orca-relay-boot', databaseUrl: 'postgres://relay@localhost/relay' }
// The message the fleet actually saw: pg-pool reports the connect timeout with
// no SQLSTATE, so the classifier has only this text to go on.
const connectTimeout = (): Error => new Error('Connection terminated due to connection timeout')
const database = {} as RelayDatabase

function loggedEvents(warn: MockInstance<typeof console.warn>): string[] {
  return warn.mock.calls.map((call) => String(JSON.parse(String(call[0])).event))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('relay boot database open', () => {
  it('waits out a cold proxy instead of failing the boot', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const open = vi
      .fn<() => Promise<RelayDatabase>>()
      .mockRejectedValueOnce(connectTimeout())
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValue(database)

    const opening = openRelayDatabaseAtBoot(input, open)
    await vi.runAllTimersAsync()

    expect(await opening).toBe(database)
    expect(open).toHaveBeenCalledTimes(3)
    expect(open).toHaveBeenCalledWith(input)
    expect(loggedEvents(warn)).toEqual([
      'orca_relay_boot_database_retry',
      'orca_relay_boot_database_retry',
      'orca_relay_boot_database_recovered'
    ])
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      attempt: 1,
      delayMs: expect.any(Number),
      code: 'unknown',
      connectionTimeout: true
    })
  })

  it('fails the boot immediately when the database rejects the relay', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const denied = Object.assign(new Error('password authentication failed'), { code: '28P01' })
    const open = vi.fn<() => Promise<RelayDatabase>>().mockRejectedValue(denied)

    await expect(openRelayDatabaseAtBoot(input, open)).rejects.toBe(denied)
    expect(open).toHaveBeenCalledTimes(1)
    expect(loggedEvents(warn)).toEqual(['orca_relay_boot_database_failed'])
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      attempts: 1,
      retryable: false,
      code: 'unknown'
    })
  })

  // A retry re-runs the schema apply, which must never re-queue a boot DDL
  // behind the writers that beat it; the request path treats these as transient.
  it.each(['55P03', '57014', '53300'])(
    'refuses to re-queue the schema apply after SQLSTATE %s',
    async (code) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const contention = Object.assign(new Error('lock unavailable'), { code })
      const open = vi.fn<() => Promise<RelayDatabase>>().mockRejectedValue(contention)

      await expect(openRelayDatabaseAtBoot(input, open)).rejects.toBe(contention)
      expect(open).toHaveBeenCalledTimes(1)
      expect(loggedEvents(warn)).toEqual(['orca_relay_boot_database_failed'])
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        attempts: 1,
        retryable: false,
        code
      })
    }
  )

  it('waits out a connection failure the driver does report a SQLSTATE for', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unreachable = Object.assign(new Error('connection refused'), { code: '08006' })
    const open = vi
      .fn<() => Promise<RelayDatabase>>()
      .mockRejectedValueOnce(unreachable)
      .mockResolvedValue(database)

    const opening = openRelayDatabaseAtBoot(input, open)
    await vi.runAllTimersAsync()

    expect(await opening).toBe(database)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('gives up once the retry budget is spent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = connectTimeout()
    const open = vi.fn<() => Promise<RelayDatabase>>().mockRejectedValue(failure)

    const opening = openRelayDatabaseAtBoot(input, open)
    const rejection = expect(opening).rejects.toBe(failure)
    await vi.runAllTimersAsync()
    await rejection

    expect(Date.now()).toBeLessThanOrEqual(45_000)
    expect(open.mock.calls.length).toBeGreaterThan(1)
    const events = loggedEvents(warn)
    expect(events.at(-1)).toBe('orca_relay_boot_database_failed')
    expect(events.filter((event) => event === 'orca_relay_boot_database_retry')).toHaveLength(
      open.mock.calls.length - 1
    )
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({
      attempts: open.mock.calls.length,
      retryable: true,
      connectionTimeout: true
    })
  })
})
