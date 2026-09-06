import { expect, it, vi } from 'vitest'
import { SessionSearchRefreshLane } from './session-search-refresh-lane'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

function barrier() {
  let resolve!: () => void
  return {
    promise: new Promise<void>((r) => {
      resolve = r
    }),
    release: () => resolve()
  }
}

it('shares concurrent tiers, preserves a remaining reader, and reads fresh after completion', async () => {
  const lane = new SessionSearchRefreshLane()
  const gate = barrier()
  const signals: AbortSignal[] = []
  const refresh = vi.fn((signal: AbortSignal) => {
    signals.push(signal)
    return gate.promise
  })
  const first = new AbortController()
  const a = lane.run({ claudeProjectsDir: '/isolated/a' }, refresh, first.signal)
  const b = lane.run({ claudeProjectsDir: '/isolated/a' }, refresh)
  first.abort()
  await expect(a).rejects.toMatchObject({ name: 'AbortError' })
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(signals[0].aborted).toBe(false)
  gate.release()
  await b
  await lane.run({ claudeProjectsDir: '/isolated/a' }, refresh)
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('isolates roots and cancels abandoned work without poisoning a retry', async () => {
  const lane = new SessionSearchRefreshLane()
  const started = barrier()
  const signals: AbortSignal[] = []
  const refresh = vi.fn((signal: AbortSignal) => {
    signals.push(signal)
    if (signals.length === 2) {
      started.release()
    }
    return waitForPromiseWithSignal(new Promise<void>(() => {}), signal)
  })
  const controller = new AbortController()
  const a = lane.run({ codexSessionsDir: '/a' }, refresh, controller.signal).catch((e) => e)
  const b = lane.run({ codexSessionsDir: '/b' }, refresh).catch((e) => e)
  await started.promise
  controller.abort()
  expect(await a).toMatchObject({ name: 'AbortError' })
  expect(signals[0].aborted).toBe(true)
  expect(signals[1].aborted).toBe(false)
  lane.cancel()
  expect(await b).toMatchObject({ name: 'AbortError' })
  await lane.run({ codexSessionsDir: '/a' }, async () => {})
})

it('does not start already-cancelled work and retries failures', async () => {
  const lane = new SessionSearchRefreshLane()
  const refresh = vi.fn(async () => {
    throw new Error('scan failure')
  })
  await expect(lane.run({}, refresh, AbortSignal.abort())).rejects.toMatchObject({
    name: 'AbortError'
  })
  expect(refresh).not.toHaveBeenCalled()
  await expect(lane.run({}, refresh)).rejects.toThrow('scan failure')
  await expect(lane.run({}, refresh)).rejects.toThrow('scan failure')
  expect(refresh).toHaveBeenCalledTimes(2)
})
