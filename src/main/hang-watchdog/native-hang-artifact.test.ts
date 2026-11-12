import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CrashReportStore } from '../crash-reporting/reports/crash-report-store'
import { createPreviousNativeHangReport } from './previous-native-hang-report'
import {
  NativeHangCaptureStore,
  readNativeHangCapture,
  readPreviousNativeHangCapture
} from './native-hang-capture-store'
import { sanitizeNativeHangReport, type NativeHangArtifact } from './native-hang-report'
import { collectBundle } from '../observability/bundle'

const sample = `Sampling process 123 for 1 second with 10 milliseconds of run time between samples
Process: Orca [123]
Path: /Users/Test User/Secret Project/Orca.app/Contents/MacOS/Orca
Analysis Tool: /Users/Test User/Private Tools/sample
OS Version: macOS 26.1 (25B78)
Call graph:
    100 Thread_1 DispatchQueue_1: com.apple.main-thread (serial)
    + 100 nativeWait (in Orca) + 12 [0x10000000c]
    100 Thread_42 background-worker
    + 100 backgroundWork (in /Users/Test User/Private (Client List)/Worker) + 8 [0x100100008]
Total number in stack (recursive counted multiple, when >=5):
    100 nativeWait
password=fixture-private-value
Binary Images:
0x100000000 - 0x1000fffff Orca (1.2.3) <AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA> /Users/Test User/Secret Project/Orca.app/Contents/MacOS/Orca
0x100100000 - 0x1001fffff Worker (4.5.6) <BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB> /Users/Test User/Private Project/Worker
`

function artifact(time: number): NativeHangArtifact {
  return {
    version: 1,
    captureId: `hang-${time}-00000000-0000-0000-0000-${String(time).padStart(12, '0')}`,
    detectedAt: time,
    capturedAt: time + 1,
    pid: 123,
    showMenuBarIcon: null,
    process: {
      appVersion: '1.2.3',
      electronVersion: '43.8.6',
      chromeVersion: '150',
      arch: 'arm64',
      osRelease: '25.1.0',
      osVersion: 'Darwin Kernel Version 25.1.0'
    },
    report: sample
  }
}

let directory: string
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'orca-native-hang-'))
})
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

it('retains every sampled thread and image identity while removing full spaced paths and credentials', async () => {
  const store = new NativeHangCaptureStore(directory)
  await store.save(artifact(1), () => false)
  const capture = await readNativeHangCapture(directory)
  expect(capture?.artifact).toMatchObject({
    showMenuBarIcon: null,
    process: { appVersion: '1.2.3', electronVersion: '43.8.6' }
  })
  expect(capture?.artifact.report).toContain('Thread_42 background-worker')
  expect(capture?.artifact.report).toContain('backgroundWork (in Worker) + 8 [0x100100008]')
  expect(capture?.artifact.report).toContain('macOS 26.1 (25B78)')
  expect(capture?.artifact.report).toContain(
    '0x100100000 - 0x1001fffff Worker (4.5.6) <BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB>'
  )
  expect(capture?.artifact.report).not.toMatch(
    /Test User|Secret Project|Private Project|Client List|Private Tools|fixture-private-value/
  )
  expect((await fs.stat(capture!.path)).mode & 0o777).toBe(0o600)
})

it('withholds complete-artifact admission for a cut report or unsafe image row', () => {
  expect(sanitizeNativeHangReport(sample.trimEnd())).toBeNull()
  expect(sanitizeNativeHangReport(sample.replace('Binary Images:', 'Missing Images:'))).toBeNull()
  expect(sanitizeNativeHangReport(`${sample}unparsed /Users/Test User/private image\n`)).toBeNull()
  expect(sanitizeNativeHangReport(sample.replace('[0x100100008]', 'unknown location'))).toBeNull()
})

it.each([
  { count: 4, times: [1, 2, 3, 4] },
  { count: 40, times: [37, 38, 39, 40] }
])(
  'bounds retained evidence after $count incidents and preserves unrelated files',
  async ({ count, times }) => {
    const store = new NativeHangCaptureStore(directory)
    await fs.writeFile(join(directory, 'unrelated.txt'), 'keep')
    await fs.writeFile(
      join(directory, 'hang-0-00000000-0000-0000-0000-000000000000.tmp'),
      'interrupted'
    )
    for (let time = 1; time <= count; time++) {
      await store.save(artifact(time), () => false)
    }
    const names = await fs.readdir(directory)
    const retained: number[] = []
    for (const name of names.filter((name) => name.endsWith('.json'))) {
      retained.push(JSON.parse(await fs.readFile(join(directory, name), 'utf8')).detectedAt)
    }
    expect(retained.sort((a, b) => a - b)).toEqual(times)
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(await fs.readFile(join(directory, 'unrelated.txt'), 'utf8')).toBe('keep')
  }
)

it('persists real recovery during publication and after completion without a startup notice', async () => {
  const store = new NativeHangCaptureStore(directory)
  let recovered = false
  const pending = store.save(artifact(1), () => recovered)
  recovered = true
  await pending
  await store.save(artifact(2), () => false)
  await store.recover(artifact(2).captureId)
  expect(await readPreviousNativeHangCapture(directory, 100)).toBeNull()
  expect((await readNativeHangCapture(directory, artifact(1).captureId))?.state).toBe('.recovered')
  expect((await readNativeHangCapture(directory, artifact(2).captureId))?.state).toBe('.recovered')
})

it('delivers one previous incident across concurrent windows and keeps it available for Help', async () => {
  await new NativeHangCaptureStore(directory).save(artifact(1), () => false)
  const store = new CrashReportStore(join(directory, 'reports.json'))
  const previous = createPreviousNativeHangReport({ store, directory, processStartedAt: 100 })
  const reports = await Promise.all([
    previous.getAutomatic(),
    previous.getAutomatic(),
    previous.getAutomatic()
  ])
  expect(reports.filter(Boolean)).toHaveLength(1)
  expect((await store.listRecent())[0]).toMatchObject({
    status: 'dismissed',
    details: { captureId: artifact(1).captureId, showMenuBarIcon: null }
  })
  expect((await readNativeHangCapture(directory, artifact(1).captureId))?.state).toBe('.seen')
  const restarted = createPreviousNativeHangReport({ store, directory, processStartedAt: 200 })
  expect(await restarted.getAutomatic()).toBeNull()
  expect((await store.listRecent())[0]?.reason).toBe('main-thread-hang')
})

it('preserves an existing pending crash and leaves the freeze eligible for a later launch', async () => {
  await new NativeHangCaptureStore(directory).save(artifact(1), () => false)
  const store = new CrashReportStore(join(directory, 'reports.json'))
  const original = await store.record({
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    platform: 'darwin',
    appVersion: '1',
    electronVersion: '43',
    chromeVersion: '150',
    arch: 'arm64',
    osRelease: '25',
    details: {}
  })
  const previous = createPreviousNativeHangReport({ store, directory, processStartedAt: 100 })
  expect(await previous.getAutomatic()).toBeNull()
  expect((await store.getLatestPending())?.id).toBe(original.id)
  await store.dismiss(original.id)
  expect(await previous.getAutomatic()).toBeNull()
  expect(await store.listRecent()).toHaveLength(1)
  expect((await readNativeHangCapture(directory, artifact(1).captureId))?.state).toBe('')
})

it('selects the reported incident and never replaces missing evidence with a newer capture', async () => {
  const store = new NativeHangCaptureStore(directory)
  await store.save(artifact(1), () => false)
  await store.save(artifact(2), () => false)
  expect((await readNativeHangCapture(directory, artifact(1).captureId))?.artifact.detectedAt).toBe(
    1
  )
  expect((await readNativeHangCapture(directory))?.artifact.detectedAt).toBe(2)
  expect(await readNativeHangCapture(directory, artifact(3).captureId)).toBeNull()
})

it('keeps an intact large capture with both log sources inside the attachment limit', async () => {
  const trace = join(directory, 'main.trace')
  const daemon = join(directory, 'daemon.log')
  await fs.writeFile(
    trace,
    `${JSON.stringify({ name: 'important-main-span', ts: new Date().toISOString(), value: 't'.repeat(16_000) })}\n`
  )
  await fs.writeFile(
    daemon,
    Array.from({ length: 200 }, () =>
      JSON.stringify({ name: 'daemon-event', value: 'a'.repeat(8_000) })
    ).join('\n')
  )
  const clean = sample.replace('password=fixture-private-value\n', '')
  const base = { type: 'native-hang-capture', status: 'complete', ...artifact(1), report: clean }
  const escapedPadding = Math.floor((3_145_600 - Buffer.byteLength(JSON.stringify(base))) / 2)
  const report = clean.replace(
    'nativeWait (in Orca)',
    `${'\\'.repeat(escapedPadding)}nativeWait (in Orca)`
  )

  const bundle = collectBundle({
    traceFilePath: trace,
    maxFiles: 1,
    daemonLogFilePath: daemon,
    appVersion: '1',
    platform: 'darwin',
    arch: 'arm64',
    osRelease: '25',
    orcaChannel: 'dev',
    nativeHangRecord: { type: 'native-hang-capture', status: 'complete', ...artifact(1), report }
  })
  const lines = bundle.payload
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(lines.find((line) => line.type === 'native-hang-capture')?.report).toBe(report)
  expect(lines.some((line) => line.name === 'important-main-span')).toBe(true)
  expect(lines.some((line) => line.name === 'daemon-event')).toBe(true)
  expect(Buffer.byteLength(bundle.payload)).toBeLessThanOrEqual(4_194_304)
  expect(bundle.bytes).toBe(Buffer.byteLength(bundle.payload))
})
