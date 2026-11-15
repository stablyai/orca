import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { consumeHangDetectionMarker, writeHangDetectionMarker } from './hang-detection-marker'
import {
  asHangObservations,
  emptyHangObservations,
  mergeHangObservations,
  retainHangObservation,
  type HangObservation
} from './hang-observations'
import { parseMacHangPressure, readCompletedHangContext } from './hang-incident-snapshot'

function observation(id: string, kind: HangObservation['kind'], sleep = false): HangObservation {
  return {
    id,
    kind,
    detectedAt: 10_000,
    parentPid: 7,
    durationMs: 162_000,
    selfRecovered: false,
    initialSleepAssociated: sleep,
    snapshot: null,
    resolution: null,
    machine: null,
    completedSpans: null,
    powerEvents: []
  }
}

it('keeps the original unexplained gap and recovered stall through subsequent ordinary sleeps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hang-retention-'))
  try {
    const gap = observation('7:1:1', 'watchdog-gap')
    const stall = observation('7:2:1', 'heartbeat-stall')
    let collection = retainHangObservation(
      retainHangObservation(emptyHangObservations(), gap),
      stall
    )
    collection = retainHangObservation(collection, {
      ...gap,
      initialSleepAssociated: true,
      powerEvents: [{ event: 'resume', observedAt: 172_000, receivedAt: 172_001 }]
    })
    collection = retainHangObservation(collection, { ...stall, selfRecovered: true })
    for (const id of ['7:3:1', '7:4:1', '7:5:1', '7:6:1', '7:7:1']) {
      collection = retainHangObservation(collection, observation(id, 'watchdog-gap', true))
    }
    collection = mergeHangObservations(
      collection,
      retainHangObservation(emptyHangObservations(), stall)
    )
    const markerPath = join(dir, 'marker.json')
    writeHangDetectionMarker(markerPath, collection)
    const persisted = asHangObservations(consumeHangDetectionMarker(markerPath))
    expect(
      persisted?.observations.map(({ id, selfRecovered, initialSleepAssociated }) => ({
        id,
        selfRecovered,
        initialSleepAssociated
      }))
    ).toEqual([
      { id: '7:1:1', selfRecovered: false, initialSleepAssociated: false },
      { id: '7:2:1', selfRecovered: true, initialSleepAssociated: false },
      { id: '7:6:1', selfRecovered: false, initialSleepAssociated: true },
      { id: '7:7:1', selfRecovered: false, initialSleepAssociated: true }
    ])
    expect(persisted?.observations[0].powerEvents).toEqual([
      { event: 'resume', observedAt: 172_000, receivedAt: 172_001 }
    ])
    expect(persisted?.omitted).toBe(3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('parses actual macOS units and page size without inventing missing measurements', () => {
  expect(
    parseMacHangPressure(
      'vm.swapusage: total = 1.50G  used = 512.00M  free = 1024.00M\nkern.memorystatus_level: 48\nkern.memorystatus_vm_pressure_level: 2\n',
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor: 42.\n'
    )
  ).toEqual({
    systemMemorySwapTotalMB: 1536,
    systemMemorySwapUsedMB: 512,
    systemMemoryCompressorMB: 0.65625,
    systemMemoryPressureLevel: 2,
    systemMemoryStatusLevel: 48
  })
  expect(parseMacHangPressure('', 'Pages occupied by compressor: 42.')).toEqual({
    systemMemorySwapTotalMB: null,
    systemMemorySwapUsedMB: null,
    systemMemoryCompressorMB: null,
    systemMemoryPressureLevel: null,
    systemMemoryStatusLevel: null
  })
})

it('keeps only complete recent context and sanitizes complete names before truncating', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hang-context-'))
  try {
    const path = join(dir, 'trace.ndjson')
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'effect-span',
        name: 'old-span',
        startTimeUnixNano: '1000000',
        endTimeUnixNano: '2000000'
      })}\n${'x'.repeat(40_000)}\n${JSON.stringify({
        type: 'effect-span',
        name: `git.exec password=${'a'.repeat(200)}`,
        startTimeUnixNano: '3000000',
        endTimeUnixNano: '4000000',
        attributes: { private: 'discard' }
      })}\n{"type":"effect-span","name":"incomplete`
    )
    expect(readCompletedHangContext(path)).toEqual([
      { name: 'git.exec [redacted:labeled-kv]', startedAt: 3, completedAt: 4 }
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
