import { expect, it } from 'vitest'
import { reduceHangProfile } from './hang-profile-reducer'
import { reduceNativeHangSample } from './native-hang-capture'
import { retainHangObservation, emptyHangObservations } from './hang-observations'
import { writeHangDetectionMarker, readAvailableHangDetectionMarker } from './hang-detection-marker'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HangObservation } from './hang-observations'

it('retains observed stacks when five equal callers have no stack above twenty percent', () => {
  const result = reduceHangProfile({
    startTime: 0,
    endTime: 100,
    samples: [1, 2, 3, 4, 5],
    nodes: [1, 2, 3, 4, 5].map((id) => ({
      id,
      callFrame: {
        functionName: `caller${id}`,
        scriptId: '1',
        url: '/private/user/app.js',
        lineNumber: 4,
        columnNumber: 2
      }
    }))
  })
  expect(result.stacks.map((item) => [item.frames[0].name, item.count, item.hot])).toEqual([
    ['caller1', 1, false],
    ['caller2', 1, false],
    ['caller3', 1, false]
  ])
  expect(result.stacks[0].frames[0]).toEqual({
    name: 'caller1',
    module: 'app.js',
    line: 5,
    column: 3
  })
})

it('requires a main section terminator independently of report truncation', () => {
  const prefix =
    '    12 Thread_10 DispatchQueue_1: com.apple.main-thread (serial)\n    + 12 appMain  (in Orca) + 1\n    +   12 kevent  (in libsystem_kernel.dylib) + 2\n'
  expect(reduceNativeHangSample(prefix)).toMatchObject({
    mainThreadIdentified: true,
    mainSectionComplete: false,
    stacks: [
      {
        frames: [
          { name: 'kevent', module: 'libsystem_kernel.dylib' },
          { name: 'appMain', module: 'Orca' }
        ],
        count: 12
      }
    ]
  })
  expect(reduceNativeHangSample(`${prefix}    12 Thread_11\n`)).toMatchObject({
    mainSectionComplete: true
  })
  expect(
    reduceNativeHangSample(prefix.replace('com.apple.main-thread', 'background'))
  ).toMatchObject({ mainThreadIdentified: false, stacks: [] })
})

it('admits escaped multibyte evidence before committing history so recovery can still be written', () => {
  const folder = mkdtempSync(join(tmpdir(), 'hang-stack-admission-'))
  try {
    let collection = emptyHangObservations()
    for (let id = 1; id <= 4; id++) {
      const record: HangObservation = {
        id: `1:${id}:1`,
        parentPid: 1,
        kind: 'heartbeat-stall',
        detectedAt: id,
        durationMs: 45_000,
        selfRecovered: false,
        initialSleepAssociated: false,
        snapshot: null,
        resolution: null,
        machine: null,
        completedSpans: null,
        powerEvents: [],
        mainJs: {
          state: 'completed',
          cleanup: 'pending',
          samplingIntervalUs: 10_000,
          requestedCaptureMs: 5000,
          budgetBasis: 'detection',
          overlap: 'unconfirmed',
          samples: 10,
          validSamples: 10,
          truncated: false,
          stacks: [1, 2, 3].map(() => ({
            count: 10,
            hot: true,
            frames: Array.from({ length: 8 }, () => ({
              name: '\\"界'.repeat(24),
              module: '\\"界'.repeat(16)
            }))
          }))
        }
      }
      collection = retainHangObservation(collection, record)
    }
    const path = join(folder, 'main-thread-hang.json')
    writeHangDetectionMarker(path, collection)
    collection = retainHangObservation(collection, {
      ...collection.observations[0],
      selfRecovered: true
    })
    writeHangDetectionMarker(path, collection)
    expect(readAvailableHangDetectionMarker(path)).toMatchObject({
      observations: [
        expect.objectContaining({ selfRecovered: true }),
        expect.anything(),
        expect.anything(),
        expect.anything()
      ]
    })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
