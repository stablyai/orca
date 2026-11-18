import { EventEmitter } from 'node:events'
import { app, type WebContents } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

type Observation = {
  state: string
  lastResult: Record<string, unknown>
  disabledForSessionReason: string | null
}
const native = vi.hoisted(() => ({ getPath: vi.fn(), getAppMetrics: vi.fn() }))
const storage = vi.hoisted(() => ({ records: new Array<Observation>() }))
vi.mock('../observability/local-file-sink', () => ({
  createLocalFileSink: () => ({
    push: (record: Observation) => storage.records.push(record),
    close: () => {
      throw new Error('Synchronous storage unavailable')
    },
    closeAsync: () => Promise.resolve()
  })
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: false, ...native }),
    powerMonitor: new EventEmitter()
  }
})

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  storage.records = []
  native.getPath.mockReturnValue('/isolated-profile')
  native.getAppMetrics.mockReturnValue([
    { pid: 41, creationTime: 100, cpu: { cumulativeCPUUsage: 1 } }
  ])
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
  vi.stubEnv('ORCA_COMPOSITOR_DIAGNOSTICS', '1')
})
afterEach(() => {
  app.emit('will-quit')
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.clearAllMocks()
})

function renderer(id: number): WebContents {
  const contents = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => false,
    getOSProcessId: () => 41
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native input double implements every WebContents member this monitor reads.
  return contents as unknown as WebContents
}

it('observes a reopened window after closing the last window in a surviving process', async () => {
  const { registerCompositorDiagnostics } = await import('./compositor-diagnostics')
  const first = renderer(11)
  registerCompositorDiagnostics(first)
  vi.advanceTimersByTime(30_000)
  first.emit('destroyed')
  vi.advanceTimersByTime(600_000)
  registerCompositorDiagnostics(renderer(12))
  vi.advanceTimersByTime(30_000)
  app.emit('will-quit')
  expect(storage.records).toContainEqual(
    expect.objectContaining({
      state: 'observing-cpu-only',
      lastResult: {
        kind: 'cpu-observation',
        processIdentity: { pid: 41, creationTime: 100 },
        cores: null,
        targets: [{ id: 12, generation: 0, surfaceIdentity: null }],
        classification: 'observations-only',
        missedProcesses: 0
      }
    })
  )
})

it('preserves a terminal session disable across a window reopening', async () => {
  const { registerCompositorDiagnostics } = await import('./compositor-diagnostics')
  const first = renderer(11)
  registerCompositorDiagnostics(first)
  native.getAppMetrics.mockImplementationOnce(() => {
    throw new Error('Native metrics unavailable')
  })
  vi.advanceTimersByTime(30_000)
  first.emit('destroyed')
  registerCompositorDiagnostics(renderer(12))
  vi.advanceTimersByTime(600_000)
  app.emit('will-quit')
  expect(storage.records.at(-1)).toMatchObject({
    state: 'disabled-for-session',
    disabledForSessionReason: 'metrics-unavailable'
  })
  expect(storage.records.some((record) => record.lastResult.kind === 'cpu-observation')).toBe(false)
})

it('stops collecting on consent loss and does not resume after a new window', async () => {
  const { registerCompositorDiagnostics } = await import('./compositor-diagnostics')
  const first = renderer(11)
  registerCompositorDiagnostics(first)
  vi.stubEnv('ORCA_DIAGNOSTICS_DISABLED', '1')
  vi.advanceTimersByTime(30_000)
  first.emit('destroyed')
  vi.stubEnv('ORCA_DIAGNOSTICS_DISABLED', '')
  registerCompositorDiagnostics(renderer(12))
  vi.advanceTimersByTime(600_000)
  expect(storage.records.map((record) => record.lastResult)).toEqual([
    expect.objectContaining({ kind: 'started' })
  ])
})
