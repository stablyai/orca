import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveSink } from '../observability/tracer'
import { hangDetectionMarkerPath, writeHangDetectionMarker } from './hang-detection-marker'
import {
  preservePreviousHangDetection,
  reportPreviousHangDetection
} from './previous-hang-detection'

vi.mock('electron', () => ({ app: {} }))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'previous-hang-'))
  for (const name of [
    'CI',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'CIRCLECI',
    'TRAVIS',
    'BUILDKITE',
    'JENKINS_URL',
    'TEAMCITY_VERSION',
    'ORCA_DIAGNOSTICS_DISABLED'
  ]) {
    vi.stubEnv(name, '')
  }
  setActiveSink(null)
})
afterEach(() => {
  setActiveSink(null)
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const marker = {
  detectedAt: 123,
  parentPid: 456,
  unresponsiveMs: 10_000,
  selfRecovered: true
}

describe('previous hang detection', () => {
  it('retains the previous run across startup and writes it only after a sink exists', () => {
    const markerPath = hangDetectionMarkerPath(dir)
    writeHangDetectionMarker(markerPath, marker)
    preservePreviousHangDetection(dir)
    expect(existsSync(markerPath)).toBe(false)
    expect(reportPreviousHangDetection(dir)).toBeNull()
    expect(existsSync(`${markerPath}.previous`)).toBe(true)
    // A new startup stall cannot replace the preserved previous run.
    writeHangDetectionMarker(markerPath, { ...marker, parentPid: 789 })
    const records: unknown[] = []
    const flush = vi.fn()
    setActiveSink({ push: (record) => records.push(record), flush, close() {} })
    expect(reportPreviousHangDetection(dir)).toEqual(marker)
    expect(records).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          'breadcrumb.name': 'main_thread_hang_detected',
          'breadcrumb.data': expect.objectContaining({
            previousPid: 456
          })
        })
      })
    ])
    expect(flush).toHaveBeenCalledOnce()
    expect(existsSync(`${markerPath}.previous`)).toBe(false)
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).parentPid).toBe(789)
    expect(reportPreviousHangDetection(dir)).toBeNull()
  })

  it('retains a pending note when a launch ends before sink installation', () => {
    const markerPath = hangDetectionMarkerPath(dir)
    writeHangDetectionMarker(markerPath, marker)
    preservePreviousHangDetection(dir)
    preservePreviousHangDetection(dir)
    expect(existsSync(`${markerPath}.previous`)).toBe(true)
    setActiveSink({ push() {}, flush() {}, close() {} })
    expect(reportPreviousHangDetection(dir)).toEqual(marker)
  })

  it('does not mutate marker files when local diagnostics are disabled', () => {
    const markerPath = hangDetectionMarkerPath(dir)
    writeHangDetectionMarker(markerPath, marker)
    vi.stubEnv('ORCA_DIAGNOSTICS_DISABLED', '1')
    preservePreviousHangDetection(dir)
    expect(existsSync(markerPath)).toBe(true)
    expect(existsSync(`${markerPath}.previous`)).toBe(false)
    expect(reportPreviousHangDetection(dir)).toBeNull()
  })
})
