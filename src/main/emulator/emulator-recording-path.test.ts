import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildEmulatorRecordingFileName,
  resolveEmulatorRecordingPath
} from './emulator-recording-path'

const RECORDINGS_DIR = join('/data', 'emulator-recordings')
const DATE = new Date('2026-06-11T20:31:04.123Z')

describe('buildEmulatorRecordingFileName', () => {
  it('builds a filesystem-safe name from the device label', () => {
    expect(buildEmulatorRecordingFileName('iPhone 16 Pro / Debug', DATE)).toBe(
      'orca-iPhone-16-Pro-Debug-2026-06-11-20-31-04.mp4'
    )
  })

  it('falls back when the device label has no usable characters', () => {
    expect(buildEmulatorRecordingFileName('///', DATE)).toBe(
      'orca-emulator-2026-06-11-20-31-04.mp4'
    )
  })
})

describe('resolveEmulatorRecordingPath', () => {
  it('defaults to a timestamped file in the recordings directory', () => {
    expect(resolveEmulatorRecordingPath(RECORDINGS_DIR, 'iPhone 17', undefined, DATE)).toBe(
      join(RECORDINGS_DIR, 'orca-iPhone-17-2026-06-11-20-31-04.mp4')
    )
  })

  it('keeps an absolute request as-is', () => {
    const requested = join('/elsewhere', 'demo.mp4')

    expect(resolveEmulatorRecordingPath(RECORDINGS_DIR, 'iPhone 17', requested, DATE)).toBe(
      requested
    )
  })

  it('anchors a relative request to the recordings directory, not the process cwd', () => {
    expect(resolveEmulatorRecordingPath(RECORDINGS_DIR, 'iPhone 17', 'demo.mp4', DATE)).toBe(
      join(RECORDINGS_DIR, 'demo.mp4')
    )
  })
})
