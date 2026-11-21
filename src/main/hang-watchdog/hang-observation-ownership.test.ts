import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as FileSystem from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HangMachineSnapshot } from './hang-observations'
import type { MainToHangWatchdogWorkerMessage } from './hang-watchdog-worker-protocol'
import { asHangObservations } from './hang-observations'
import { consumeHangDetectionMarker, writeHangDetectionMarker } from './hang-detection-marker'
import { runWatchdog } from './main-thread-hang-watchdog-entry'
import { preservePreviousHangDetection } from './previous-hang-detection'

const probes = vi.hoisted<{ pending: ((value: HangMachineSnapshot) => void)[] }>(() => ({
  pending: []
}))
const files = vi.hoisted<{ unavailablePath: string | null }>(() => ({ unavailablePath: null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === files.unavailablePath) {
        throw Object.assign(new Error('temporarily unreadable'), { code: 'EIO' })
      }
      return actual.readFileSync(...args)
    }
  }
})
vi.mock('../observability', () => ({
  resolveObservabilityConsent: () => ({ localFileEnabled: true })
}))
vi.mock('./hang-incident-snapshot', () => ({
  readCompletedHangContext: () => [],
  collectHangMachineSnapshot: () =>
    new Promise<HangMachineSnapshot>((resolve) => probes.pending.push(resolve))
}))
const staleMachine: HangMachineSnapshot = {
  startedAt: 125,
  completedAt: 250,
  systemMemoryTotalMB: 64_000,
  systemMemoryFreeMB: 8_000,
  systemMemorySwapTotalMB: 1024,
  systemMemorySwapUsedMB: 100,
  systemMemoryCompressorMB: 500,
  systemMemoryPressureLevel: 2,
  systemMemoryStatusLevel: 40,
  load1: 2,
  load5: 3,
  load15: 4
}
beforeEach(() => {
  probes.pending = []
  files.unavailablePath = null
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  files.unavailablePath = null
  for (const resolve of probes.pending) {
    resolve(staleMachine)
  }
  vi.useRealTimers()
})

it('cannot let a retired pressure read replace a newer stall or undo recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hang-ownership-'))
  const markerPath = join(dir, 'marker.json')
  let send: (message: MainToHangWatchdogWorkerMessage) => void = () => {}
  runWatchdog(
    { parentPid: process.pid, markerPath, timeoutMs: 100, checkIntervalMs: 25 },
    {
      on: (_event, listener) => {
        send = listener
      },
      close() {}
    }
  )
  try {
    vi.advanceTimersByTime(125)
    await vi.dynamicImportSettled()
    send({ type: 'heartbeat' })
    vi.advanceTimersByTime(125)
    probes.pending[0](staleMachine)
    await vi.dynamicImportSettled()
    const records = asHangObservations(consumeHangDetectionMarker(markerPath))?.observations
    expect(
      records?.map(({ kind, selfRecovered, machine }) => ({ kind, selfRecovered, machine }))
    ).toEqual([
      { kind: 'heartbeat-stall', selfRecovered: true, machine: null },
      { kind: 'heartbeat-stall', selfRecovered: false, machine: null }
    ])
    expect(records?.[0].snapshot).not.toBeNull()
    expect(records?.[0].resolution).not.toBeNull()
    expect(records?.[1].resolution).toBeNull()
  } finally {
    send({ type: 'shutdown' })
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([
  { scenario: 'open suspend across a normal tick', suspendAt: 0, resumeAt: null, expected: true },
  { scenario: 'completed sleep before a normal tick', suspendAt: 0, resumeAt: 0, expected: false },
  { scenario: 'resume before the overdue tick', suspendAt: 0, resumeAt: 1000, expected: true },
  { scenario: 'suspend at the gap end', suspendAt: 1000, resumeAt: null, expected: false }
])('retains honest sleep association for $scenario', ({ suspendAt, resumeAt, expected }) => {
  const dir = mkdtempSync(join(tmpdir(), 'hang-power-gap-'))
  const markerPath = join(dir, 'marker.json')
  let send: (message: MainToHangWatchdogWorkerMessage) => void = () => {}
  runWatchdog(
    { parentPid: process.pid, markerPath, timeoutMs: 100, checkIntervalMs: 25 },
    {
      on: (_event, listener) => {
        send = listener
      },
      close() {}
    }
  )
  try {
    if (suspendAt === 0) {
      send({ type: 'power-event', event: 'suspend', observedAt: 0 })
    }
    if (resumeAt === 0) {
      send({ type: 'power-event', event: 'resume', observedAt: 0 })
    }
    vi.advanceTimersByTime(25)
    send({ type: 'heartbeat' })
    vi.setSystemTime(1000)
    if (suspendAt === 1000) {
      send({ type: 'power-event', event: 'suspend', observedAt: 1000 })
    }
    if (resumeAt === 1000) {
      send({ type: 'power-event', event: 'resume', observedAt: 1000 })
    }
    vi.advanceTimersByTime(25)
    const collection = asHangObservations(consumeHangDetectionMarker(markerPath))
    expect(collection?.observations).toMatchObject([
      { kind: 'watchdog-gap', initialSleepAssociated: expected, resolution: null }
    ])
    if (suspendAt === 1000) {
      for (let index = 0; index < 5; index++) {
        send({ type: 'power-event', event: 'resume', observedAt: Date.now() })
        send({ type: 'heartbeat' })
        send({ type: 'power-event', event: 'suspend', observedAt: Date.now() })
        vi.advanceTimersByTime(25)
        vi.setSystemTime(Date.now() + 1000)
        vi.advanceTimersByTime(25)
      }
      expect(
        asHangObservations(consumeHangDetectionMarker(markerPath))?.observations
      ).toContainEqual(expect.objectContaining({ detectedAt: 1025, initialSleepAssociated: false }))
    }
  } finally {
    send({ type: 'shutdown' })
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps unavailable startup bytes until a later observation can safely merge them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hang-unavailable-'))
  const markerPath = join(dir, 'main-thread-hang.json')
  const original = { detectedAt: 1, parentPid: 999, unresponsiveMs: 45_000, selfRecovered: false }
  writeHangDetectionMarker(markerPath, original)
  const originalBytes = readFileSync(markerPath, 'utf8')
  files.unavailablePath = markerPath
  preservePreviousHangDetection(dir)
  let send: (message: MainToHangWatchdogWorkerMessage) => void = () => {}
  runWatchdog(
    { parentPid: process.pid, markerPath, timeoutMs: 100, checkIntervalMs: 25 },
    {
      on: (_event, listener) => {
        send = listener
      },
      close() {}
    }
  )
  try {
    vi.advanceTimersByTime(125)
    files.unavailablePath = null
    expect(readFileSync(markerPath, 'utf8')).toBe(originalBytes)
    send({ type: 'heartbeat' })
    expect(asHangObservations(consumeHangDetectionMarker(markerPath))?.observations).toMatchObject([
      { parentPid: 999, detectedAt: 1, selfRecovered: false },
      { parentPid: process.pid, detectedAt: 125, selfRecovered: true }
    ])
  } finally {
    send({ type: 'shutdown' })
    rmSync(dir, { recursive: true, force: true })
  }
})
