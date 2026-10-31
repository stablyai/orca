import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostPressureLevel, SpawnIntent } from '../../shared/host-spawn-admission'
import { createUserResumeSpawnPacer } from '../ipc/pty/ipc/user-resume-spawn-pacer'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { TerminalHost } from './terminal-host'
import { TerminalSpawnGate } from './terminal-spawn-gate'

const cases = [
  { name: 'fast forks', firstForkMs: 40, preparationMs: 0, otherForkMs: 0 },
  { name: 'three-second forks', firstForkMs: 3000, preparationMs: 0, otherForkMs: 0 },
  { name: 'slow initial forks', firstForkMs: 15_000, preparationMs: 0, otherForkMs: 0 },
  { name: 'shared account preparation', firstForkMs: 40, preparationMs: 5000, otherForkMs: 0 },
  {
    name: 'another client holding a user slot',
    firstForkMs: 40,
    preparationMs: 0,
    otherForkMs: 3000
  }
]

describe('user-resume reservations against the enforcing terminal host', () => {
  let host: TerminalHost | undefined
  beforeEach(() => vi.useFakeTimers({ now: 0 }))
  afterEach(async () => {
    const disposing = host?.dispose()
    await vi.runOnlyPendingTimersAsync()
    await disposing
    vi.useRealTimers()
  })

  it.each(cases)('restarts all 12 panes with $name at critical pressure', async (testCase) => {
    let pressure: HostPressureLevel = 'ok'
    let paused = false
    let forkNumber = 0
    const log = vi.fn()
    const gate = new TerminalSpawnGate({
      mode: 'enforce',
      pressure: () => pressure,
      automaticWorkMode: () =>
        paused ? { kind: 'paused', reason: 'operator', since: Date.now() } : { kind: 'normal' },
      log
    })
    const spawnSubprocess = vi.fn(async (opts: { sessionId: string }) => {
      const delay =
        opts.sessionId === 'other-client'
          ? testCase.otherForkMs
          : opts.sessionId.startsWith('replacement-')
            ? forkNumber++ < 3
              ? testCase.firstForkMs
              : 40
            : 0
      if (delay) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
      }
      return createMockSubprocess()
    })
    const terminalHost = new TerminalHost({ spawnSubprocess, spawnGate: gate })
    host = terminalHost
    const create = (sessionId: string, declaredIntent: SpawnIntent, clientId = 'main-client') =>
      terminalHost.createOrAttach({
        sessionId,
        cols: 80,
        rows: 24,
        historySeedChunks: declaredIntent === 'interactive' ? undefined : ['seed'],
        spawnAdmission: { clientId, declaredIntent, deadlineAt: Date.now() + 12_000 },
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    for (let i = 0; i < 8; i++) {
      await create(`automatic-${i}`, 'automatic-restore')
      await vi.advanceTimersByTimeAsync(1000)
    }
    for (let i = 0; i < 12; i++) {
      await create(`old-${i}`, 'interactive')
    }
    expect(gate.snapshot().liveAutomatic).toBe(8)
    pressure = 'critical'
    paused = true
    const other = testCase.otherForkMs
      ? create('other-client', 'user-resume', 'other-client')
      : Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    log.mockClear()
    const pacer = createUserResumeSpawnPacer()
    const startedAt = Date.now()
    const stoppedAt: number[] = []
    const preparation = new Promise<void>((resolve) => setTimeout(resolve, testCase.preparationMs))
    const restarts = Array.from({ length: 12 }, (_, i) =>
      (async () => {
        const release = await pacer.take()
        try {
          stoppedAt.push(Date.now() - startedAt)
          await terminalHost.kill(`old-${i}`, { immediate: true })
          await preparation
          await create(`replacement-${i}`, 'user-resume')
          return 'restarted'
        } finally {
          release()
        }
      })().catch((error: unknown) => String(error))
    )
    await vi.advanceTimersByTimeAsync(90_000)
    await other

    expect(await Promise.all(restarts)).toEqual(Array(12).fill('restarted'))
    expect(forkNumber).toBe(12)
    expect(gate.snapshot()).toMatchObject({ liveAutomatic: 8, deferred: 0 })
    expect(stoppedAt.slice(0, 3)).toEqual([0, 0, 0])
    expect(stoppedAt[3]).toBeGreaterThanOrEqual(2500)
    const admissions = log.mock.calls.filter(([event]) => event === 'spawn-admission')
    expect(admissions).toHaveLength(12)
    expect(admissions.every(([, details]) => details.charge === 'user')).toBe(true)
    if (testCase.otherForkMs) {
      expect(gate.snapshot().waited).toBeGreaterThan(0)
    }
  })
})
