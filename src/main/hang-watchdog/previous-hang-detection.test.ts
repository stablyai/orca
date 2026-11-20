import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveSink } from '../observability/tracer'
import { createLocalFileSink } from '../observability/local-file-sink'
import { collectBundle } from '../observability/bundle'
import {
  emptyHangObservations,
  retainHangObservation,
  type HangObservation
} from './hang-observations'
import { hangDetectionMarkerPath, writeHangDetectionMarker } from './hang-detection-marker'
import {
  publishRendererHang,
  preservePreviousRendererHangs,
  reportPreviousRendererHangs
} from './renderer-hang-records'
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
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const marker = {
  detectedAt: 123,
  parentPid: 456,
  unresponsiveMs: 10_000,
  selfRecovered: true
}
const gap: HangObservation = {
  id: '789:200:1',
  kind: 'watchdog-gap',
  detectedAt: 200,
  parentPid: 789,
  durationMs: 162_000,
  selfRecovered: false,
  initialSleepAssociated: false,
  snapshot: {
    wallMs: 200,
    monotonicMs: 100,
    uptimeSeconds: 1000,
    processUserUs: 500,
    processSystemUs: 200,
    watchdogUserUs: null,
    watchdogSystemUs: null
  },
  resolution: null,
  machine: null,
  completedSpans: null,
  powerEvents: []
}

describe('previous hang detection', () => {
  it('retains the previous run across startup and writes it only after a sink exists', () => {
    const markerPath = hangDetectionMarkerPath(dir)
    writeHangDetectionMarker(markerPath, marker)
    preservePreviousHangDetection(dir)
    expect(existsSync(markerPath)).toBe(false)
    expect(reportPreviousHangDetection(dir)).toBeNull()
    expect(existsSync(`${markerPath}.previous`)).toBe(true)
    writeHangDetectionMarker(markerPath, retainHangObservation(emptyHangObservations(), gap))
    preservePreviousHangDetection(dir)
    expect(existsSync(markerPath)).toBe(false)
    writeHangDetectionMarker(markerPath, { ...marker, parentPid: 789 })
    const records: unknown[] = []
    setActiveSink({ push: (record) => records.push(record), flush() {}, close() {} })
    expect(reportPreviousHangDetection(dir)).toEqual(marker)
    expect(records).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          'breadcrumb.name': 'main_thread_hang_detected',
          'breadcrumb.data': expect.objectContaining({
            previousPid: 456
          })
        })
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          'breadcrumb.name': 'main_thread_watchdog_gap',
          'breadcrumb.data': expect.objectContaining({ previousPid: 789 })
        })
      })
    ])
    expect(existsSync(`${markerPath}.previous`)).toBe(false)
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).parentPid).toBe(789)
    expect(reportPreviousHangDetection(dir)).toBeNull()
    expect(records).toHaveLength(2)
  })

  it('keeps the hang marker and its telemetry for hangs only while later short stalls arrive', () => {
    const hang: HangObservation = {
      ...gap,
      id: '789:300:1',
      kind: 'heartbeat-stall',
      detectedAt: 300,
      durationMs: 46_000,
      selfRecovered: true,
      tier: 'hang'
    }
    let collection = retainHangObservation(emptyHangObservations(), hang)
    for (let index = 0; index < 4; index++) {
      collection = retainHangObservation(collection, {
        ...hang,
        id: `789:${400 + index}:${index + 2}`,
        detectedAt: 400 + index,
        durationMs: 9_000,
        tier: 'stall'
      })
    }
    writeHangDetectionMarker(hangDetectionMarkerPath(dir), collection)
    preservePreviousHangDetection(dir)
    const breadcrumbNames: unknown[] = []
    setActiveSink({
      push: (record) => {
        const attributes =
          typeof record === 'object' && record !== null && 'attributes' in record
            ? record.attributes
            : null
        if (
          typeof attributes === 'object' &&
          attributes !== null &&
          'breadcrumb.name' in attributes
        ) {
          breadcrumbNames.push(attributes['breadcrumb.name'])
        }
      },
      flush() {},
      close() {}
    })
    expect(reportPreviousHangDetection(dir)).toEqual({
      detectedAt: 300,
      parentPid: 789,
      unresponsiveMs: 46_000,
      selfRecovered: true
    })
    expect(breadcrumbNames).toEqual([
      'main_thread_hang_detected',
      'main_thread_stall_detected',
      'main_thread_stall_detected',
      'main_thread_stall_detected'
    ])
  })

  it('keeps a new stall when four hangs are already retained', () => {
    let collection = emptyHangObservations()
    for (let index = 0; index < 4; index++) {
      collection = retainHangObservation(collection, {
        ...gap,
        id: `789:${300 + index}:${index + 1}`,
        kind: 'heartbeat-stall',
        detectedAt: 300 + index,
        durationMs: 46_000,
        tier: 'hang'
      })
    }
    const stall: HangObservation = {
      ...gap,
      id: '789:900:9',
      kind: 'heartbeat-stall',
      detectedAt: 900,
      durationMs: 9_000,
      tier: 'stall'
    }
    const live = retainHangObservation(collection, stall, { reserve: true })
    expect(live.observations.map((item) => item.id)).toContain('789:900:9')
    expect(live.observations).toHaveLength(4)
    // A startup replay of the same unrecovered stall keeps every pending hang instead.
    const replayed = retainHangObservation(collection, stall)
    expect(replayed.observations.map((item) => item.id)).not.toContain('789:900:9')
  })

  it('reports an escalated hang that never recovered as lasting at least until escalation', () => {
    const escalated: HangObservation = {
      ...gap,
      id: '789:10000:1',
      kind: 'heartbeat-stall',
      detectedAt: 10_000,
      durationMs: 10_000,
      tier: 'hang',
      escalatedAt: 50_000
    }
    writeHangDetectionMarker(
      hangDetectionMarkerPath(dir),
      retainHangObservation(emptyHangObservations(), escalated)
    )
    preservePreviousHangDetection(dir)
    setActiveSink({ push() {}, flush() {}, close() {} })
    expect(reportPreviousHangDetection(dir)).toEqual({
      detectedAt: 10_000,
      parentPid: 789,
      unresponsiveMs: 50_000,
      selfRecovered: false
    })
  })

  it('reports an escalated hang whose recovery was stamped before its escalation as lasting to escalation', () => {
    const escalated: HangObservation = {
      ...gap,
      id: '789:12000:1',
      kind: 'heartbeat-stall',
      detectedAt: 12_000,
      durationMs: 10_000,
      selfRecovered: true,
      tier: 'hang',
      escalatedAt: 47_001,
      resolution: { ...gap.snapshot!, wallMs: 46_000 }
    }
    writeHangDetectionMarker(
      hangDetectionMarkerPath(dir),
      retainHangObservation(emptyHangObservations(), escalated)
    )
    preservePreviousHangDetection(dir)
    setActiveSink({ push() {}, flush() {}, close() {} })
    expect(reportPreviousHangDetection(dir)?.unresponsiveMs).toBe(45_001)
  })

  it('reads a stall-only previous run as no hang', () => {
    const stall: HangObservation = {
      ...gap,
      id: '789:300:1',
      kind: 'heartbeat-stall',
      durationMs: 13_000,
      selfRecovered: true,
      tier: 'stall'
    }
    writeHangDetectionMarker(
      hangDetectionMarkerPath(dir),
      retainHangObservation(emptyHangObservations(), stall)
    )
    preservePreviousHangDetection(dir)
    setActiveSink({ push() {}, flush() {}, close() {} })
    expect(reportPreviousHangDetection(dir)).toBeNull()
  })

  it('carries gap and overlapping-stall evidence through the real trace and bundle', () => {
    const traceFilePath = join(dir, 'logs', 'main.trace.ndjson')
    const sink = createLocalFileSink({ filePath: traceFilePath, maxFiles: 1 })
    try {
      writeHangDetectionMarker(
        hangDetectionMarkerPath(dir),
        retainHangObservation(emptyHangObservations(), gap)
      )
      preservePreviousHangDetection(dir)
      setActiveSink(sink)
      expect(reportPreviousHangDetection(dir)).toBeNull()
      const stall: HangObservation = {
        ...gap,
        id: '789:300:2',
        kind: 'heartbeat-stall',
        detectedAt: 300,
        durationMs: 45_000,
        selfRecovered: true,
        snapshot: { ...gap.snapshot!, wallMs: 300, processUserUs: 100 },
        resolution: { ...gap.snapshot!, wallMs: 500, processUserUs: 900 },
        watchdogGap: {
          observedAt: 400,
          durationMs: 162_000,
          snapshot: { ...gap.snapshot!, wallMs: 400, processUserUs: 600, watchdogUserUs: 3 }
        },
        machine: {
          startedAt: 301,
          completedAt: 302,
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
      }
      writeHangDetectionMarker(
        hangDetectionMarkerPath(dir),
        retainHangObservation(emptyHangObservations(), stall)
      )
      preservePreviousHangDetection(dir)
      expect(reportPreviousHangDetection(dir)).toEqual({
        detectedAt: 300,
        parentPid: 789,
        unresponsiveMs: 45_200,
        selfRecovered: true
      })
      const bundle = collectBundle({
        traceFilePath,
        maxFiles: 1,
        appVersion: 'test',
        platform: 'darwin',
        arch: 'arm64',
        osRelease: 'test',
        orcaChannel: 'dev'
      })
      const records = bundle.payload
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((record) => record.type === 'effect-span')
      const gapRecord = records.find(
        (record) => record.attributes['breadcrumb.name'] === 'main_thread_watchdog_gap'
      )
      const stallRecord = records.find(
        (record) => record.attributes['breadcrumb.name'] === 'main_thread_hang_detected'
      )
      expect(gapRecord?.attributes['breadcrumb.data']).toMatchObject({
        watchdogGapMs: 162_000,
        cause: 'unknown',
        activeMainActivity: 'unknown',
        detection_processUserUs: 500,
        preGapCpuDeltaUs: null,
        watchdogCpuDetectionToResolutionUs: null,
        machineEvidence: 'unknown'
      })
      expect(stallRecord?.attributes['breadcrumb.data']).toMatchObject({
        detection_wallMs: 300,
        detection_processUserUs: 100,
        gapEnd_wallMs: 400,
        gapEnd_processUserUs: 600,
        gapEnd_watchdogUserUs: 3,
        resolution_wallMs: 500,
        resolution_processUserUs: 900,
        machine_startedAt: 301,
        machine_completedAt: 302,
        machine_systemMemorySwapUsedMB: 100
      })
      expect(stallRecord?.attributes['breadcrumb.data']).not.toHaveProperty('startedAt')
    } finally {
      setActiveSink(null)
      sink.close()
    }
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

it('replays an old renderer capture into the current trace before consuming it so the default bundle includes it', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
  const detectedAt = 1794391200000
  await publishRendererHang(dir, {
    id: `456:${detectedAt}:3`,
    parentPid: 456,
    windowId: 3,
    detectedAt,
    status: 'captured',
    samples: 1,
    validSamples: 1,
    truncated: false,
    stacks: [
      {
        count: 1,
        hot: true,
        frames: [{ name: 'busyCaller', module: 'app.js', line: 7, column: 3 }]
      }
    ]
  })
  preservePreviousRendererHangs(dir)
  reportPreviousRendererHangs(dir)
  expect(existsSync(join(dir, 'renderer-hang.json.previous'))).toBe(true)
  const traceFilePath = join(dir, 'logs', 'main.trace.ndjson')
  const sink = createLocalFileSink({ filePath: traceFilePath, maxFiles: 1 })
  try {
    setActiveSink(sink)
    reportPreviousRendererHangs(dir)
    expect(existsSync(join(dir, 'renderer-hang.json.previous'))).toBe(false)
    const bundle = collectBundle({
      traceFilePath,
      maxFiles: 1,
      appVersion: 'test',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: 'test',
      orcaChannel: 'dev'
    })
    const records = bundle.payload
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const capture = records.find(
      (record) => record.attributes?.['breadcrumb.name'] === 'renderer_hang_capture'
    )
    expect(capture?.attributes['breadcrumb.data']).toMatchObject({
      detectedAt,
      previousPid: 456,
      rendererJs0_frame0: 'busyCaller [app.js:7:3]',
      rendererJs0_count: 1
    })
  } finally {
    setActiveSink(null)
    sink.close()
  }
})

it('puts renderer completion into the current bundle while retaining next-launch evidence', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
  const traceFilePath = join(dir, 'logs', 'main.trace.ndjson')
  const sink = createLocalFileSink({ filePath: traceFilePath, maxFiles: 1 })
  try {
    setActiveSink(sink)
    await publishRendererHang(dir, {
      id: '123:1000:3',
      parentPid: 123,
      windowId: 3,
      detectedAt: 1000,
      completedAt: 2000,
      status: 'captured',
      samples: 1,
      validSamples: 1,
      truncated: false,
      stacks: [
        {
          count: 1,
          hot: true,
          frames: [{ name: 'rendererBusy', module: 'app.js', line: 9, column: 2 }]
        }
      ]
    })
    const bundle = collectBundle({
      traceFilePath,
      maxFiles: 1,
      appVersion: 'test',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: 'test',
      orcaChannel: 'dev'
    })
    const capture = bundle.payload
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((record) => record.attributes?.['breadcrumb.name'] === 'renderer_hang_capture')
    expect(capture?.attributes['breadcrumb.data']).toMatchObject({
      detectedAt: 1000,
      completedAt: 2000,
      rendererJs0_frame0: 'rendererBusy [app.js:9:2]'
    })
    expect(JSON.parse(readFileSync(join(dir, 'renderer-hang.json'), 'utf8'))).toMatchObject({
      records: [expect.objectContaining({ completedAt: 2000 })]
    })
  } finally {
    setActiveSink(null)
    sink.close()
  }
})
