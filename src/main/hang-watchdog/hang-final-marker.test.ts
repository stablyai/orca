import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createHangMarkerWriter,
  readAvailableHangDetectionMarker,
  writeHangDetectionMarker
} from './hang-detection-marker'
import { finalHangMarkerPath, mergeFinalHangMarker } from './hang-final-marker'
import { asHangObservations, type HangObservation } from './hang-observations'
import { findUnrecoveredStall } from './unrecovered-stall-selection'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function collection(record: HangObservation) {
  return { version: 1 as const, observations: [record], omitted: 0 }
}

describe('shutdown marker vs an in-flight async write', () => {
  it('a clean quit racing an already-submitted async rename is not read back as a freeze', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hang-final-'))
    dirs.push(dir)
    const markerPath = join(dir, 'main-thread-hang.json')
    const open: HangObservation = {
      id: '4242:1000:1',
      kind: 'heartbeat-stall',
      detectedAt: 1_000,
      parentPid: 4242,
      durationMs: 9_000,
      selfRecovered: false,
      initialSleepAssociated: false,
      snapshot: null,
      resolution: null,
      machine: null,
      completedSpans: null,
      powerEvents: [],
      tier: 'stall'
    }
    const recovered = { ...open, selfRecovered: true }
    const writer = createHangMarkerWriter(markerPath, writeHangDetectionMarker)

    // The tick's async write is in flight when main sends shutdown.
    writer.write(collection(open))
    writer.flushPending(collection(recovered))
    // Let the submitted rename land after the shutdown write, as it can before exit.
    await expect
      .poll(() => {
        try {
          return readFileSync(markerPath, 'utf8').includes('"selfRecovered":false')
        } catch {
          return false
        }
      })
      .toBe(true)

    const merged = mergeFinalHangMarker(
      asHangObservations(readAvailableHangDetectionMarker(markerPath)),
      readAvailableHangDetectionMarker(finalHangMarkerPath(markerPath))
    )
    expect(merged?.observations).toHaveLength(1)
    expect(findUnrecoveredStall(merged?.observations ?? [])).toBeNull()
  })
})
