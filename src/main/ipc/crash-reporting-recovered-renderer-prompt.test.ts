import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listeners } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listeners: new Map<string, (_event: unknown, args?: unknown) => void>()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.4.162' },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel)),
    on: vi.fn((channel: string, listener: (_event: unknown, args?: unknown) => void) => {
      listeners.set(channel, listener)
    })
  }
}))

vi.mock('./feedback', () => ({ submitFeedback: vi.fn() }))

vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  getCrashBreadcrumbSnapshot: vi.fn(() => []),
  recordCoalescedCrashBreadcrumb: vi.fn(() => ({ suppressedSinceLast: 0 })),
  recordCrashBreadcrumb: vi.fn()
}))

vi.mock('../observability', () => ({
  collectDiagnosticBundle: vi.fn(),
  getDiagnosticsStatus: vi.fn()
}))

vi.mock('../observability/diagnostic-upload-endpoint', () => ({
  resolveDiagnosticOrcaChannel: vi.fn()
}))

vi.mock('../observability/tracer', () => ({
  startSpan: vi.fn(() => ({
    traceId: 'trace-id',
    spanId: 'span-id',
    setAttribute: vi.fn(),
    addEvent: vi.fn(),
    fail: vi.fn(),
    interrupt: vi.fn(),
    end: vi.fn()
  })),
  flushActiveSink: vi.fn()
}))

import { CrashReportStore } from '../crash-reporting/crash-report-store'
import {
  _resetRendererRecoveryOutcomeForTests,
  clearRendererRecoveryReloadIssued,
  noteRendererRecoveryReloadIssued,
  resolveRecoveredRendererCrashReports
} from '../crash-reporting/renderer-recovery-crash-outcome'
import type { CrashReportCreateInput, CrashReportRecord } from '../../shared/crash-reporting'
import {
  _resetRendererErrorReportDedupeForTests,
  registerCrashReportingHandlers
} from './crash-reporting'

const tempDirs: string[] = []

async function createStore(): Promise<CrashReportStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-recovered-renderer-crash-'))
  tempDirs.push(dir)
  return new CrashReportStore(path.join(dir, 'crash-reports.json'))
}

// The cluster-F shape: macOS/Linux SIGKILL, Windows uses different codes on the same path.
function killedRendererCrash(exitCode = 9): CrashReportCreateInput {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'killed',
    exitCode,
    appVersion: '1.4.162',
    platform: process.platform,
    osRelease: 'test',
    arch: process.arch,
    electronVersion: '41',
    chromeVersion: '141',
    details: { processType: 'renderer' },
    // Why: the pre-crash trail is the whole point of keeping the healed report
    // sendable, so the retention assertion needs a non-empty snapshot.
    breadcrumbs: [
      { createdAt: '2026-08-01T00:00:00.000Z', name: 'renderer_bootstrap_rendered' },
      { createdAt: '2026-08-01T00:00:01.000Z', name: 'terminal_focus', data: { paneKey: 'a' } }
    ]
  }
}

// Same `source`, different producer: reported by the renderer's own error
// boundary, not by a dead renderer process.
function reactErrorBoundaryCrash(): CrashReportCreateInput {
  return {
    ...killedRendererCrash(),
    processType: 'react-render',
    reason: 'react-error-boundary',
    exitCode: null,
    details: { processType: 'react-render' }
  }
}

// A kernel OOM-kill / jetsam burst takes a child process down with the renderer.
function killedChildCrash(): CrashReportCreateInput {
  return {
    ...killedRendererCrash(),
    source: 'child',
    processType: 'Utility',
    details: { processType: 'Utility', serviceName: 'storage.mojom.StorageService' }
  }
}

function emitRendererBootstrapRendered(): void {
  listeners.get('crashReports:recordBreadcrumb')?.(null, { name: 'renderer_bootstrap_rendered' })
}

async function getLatestPending(): Promise<CrashReportRecord | null> {
  return (await handlers.get('crashReports:getLatestPending')?.(null)) as CrashReportRecord | null
}

async function getLatestReport(): Promise<CrashReportRecord | null> {
  return (await handlers.get('crashReports:getLatestReport')?.(null)) as CrashReportRecord | null
}

beforeEach(() => {
  handlers.clear()
  listeners.clear()
  _resetRendererRecoveryOutcomeForTests()
  _resetRendererErrorReportDedupeForTests()
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('auto-recovered renderer crash reporting', () => {
  it('does not prompt the recovered renderer for a crash the reload healed', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    await store.record(killedRendererCrash())

    noteRendererRecoveryReloadIssued()
    emitRendererBootstrapRendered()

    await expect(getLatestPending()).resolves.toBeNull()
  })

  it.each([
    ['macOS/Linux SIGKILL', 9],
    ['Windows ACCESS_VIOLATION', -1073741819],
    ['Windows renderer OOM', -536870904]
  ])('suppresses the prompt for %s once recovery is observed', async (_label, exitCode) => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    await store.record(killedRendererCrash(exitCode))

    noteRendererRecoveryReloadIssued()
    emitRendererBootstrapRendered()

    await expect(getLatestPending()).resolves.toBeNull()
  })

  it('keeps the healed report sendable from Help > Report Crash with its recovery flag', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    const recorded = await store.record(killedRendererCrash())

    noteRendererRecoveryReloadIssued()
    emitRendererBootstrapRendered()
    await getLatestPending()

    const sendable = await getLatestReport()
    expect(sendable?.id).toBe(recorded.id)
    expect(sendable?.status).toBe('dismissed')
    expect(sendable?.details.rendererAutoRecovered).toBe(true)
    expect(sendable?.breadcrumbs).toEqual(recorded.breadcrumbs)
  })

  it('still prompts for a React error-boundary crash caught in the recovery window', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    const recorded = await store.record(reactErrorBoundaryCrash())

    noteRendererRecoveryReloadIssued()
    emitRendererBootstrapRendered()

    await expect(getLatestPending()).resolves.toMatchObject({ id: recorded.id, status: 'pending' })
    expect((await getLatestReport())?.details.rendererAutoRecovered).toBeUndefined()
  })

  it('resolves the process crash without sweeping a React error-boundary crash beside it', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    // Why the crash-shaped reason/exitCode: relation matching ignores
    // processType, so a boundary report only survives the sweep on its own
    // guard — not on the reason literal happening not to collide.
    const boundary = await store.record({
      ...reactErrorBoundaryCrash(),
      reason: 'killed',
      exitCode: 9
    })
    await store.record(killedRendererCrash())

    noteRendererRecoveryReloadIssued()
    emitRendererBootstrapRendered()

    await expect(getLatestPending()).resolves.toMatchObject({ id: boundary.id, status: 'pending' })
  })

  it('sweeps a sibling child crash from the same kill burst', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    await store.record(killedChildCrash())
    await store.record(killedRendererCrash())

    noteRendererRecoveryReloadIssued()
    emitRendererBootstrapRendered()

    await expect(getLatestPending()).resolves.toBeNull()
  })

  it('leaves an unrelated pending crash alone while sweeping the burst', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    const unrelated = await store.record({ ...killedChildCrash(), reason: 'oom', exitCode: 5 })
    await store.record(killedRendererCrash())

    noteRendererRecoveryReloadIssued()
    emitRendererBootstrapRendered()

    await expect(getLatestPending()).resolves.toMatchObject({ id: unrelated.id, status: 'pending' })
  })

  // Why 25s: inside the arm's own 30s validity, but long before the crash that
  // armed it. Crediting it would dismiss an unhealed crash as auto-recovered.
  it('leaves a crash older than the burst pending when a later reload is armed', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    const stale = await store.record({ ...killedRendererCrash(), reason: 'oom', exitCode: null })

    const armedMs = Date.parse(stale.createdAt) + 25_000
    noteRendererRecoveryReloadIssued(armedMs)
    resolveRecoveredRendererCrashReports(store, armedMs)

    await expect(getLatestPending()).resolves.toMatchObject({ id: stale.id, status: 'pending' })
  })

  // Why: the recovery reload is armed by a 250ms timer that a loaded machine can
  // run seconds late, so the crash that armed it must stay in scope past that.
  it('credits the crash that armed a recovery reload the main process ran late', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    const recorded = await store.record(killedRendererCrash())

    const armedMs = Date.parse(recorded.createdAt) + 4_000
    noteRendererRecoveryReloadIssued(armedMs)
    resolveRecoveredRendererCrashReports(store, armedMs)

    await expect(getLatestPending()).resolves.toBeNull()
  })

  // Why: the arm outlives the reload by far longer than the lookback, because
  // session restore over SSH can push the first render many seconds out.
  it('resolves the crash when the recovered renderer takes many seconds to boot', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    await store.record(killedRendererCrash())

    const armedMs = Date.now()
    noteRendererRecoveryReloadIssued(armedMs)
    resolveRecoveredRendererCrashReports(store, armedMs + 20_000)

    await expect(getLatestPending()).resolves.toBeNull()
  })

  it('still prompts when the renderer booted without an auto-recovery reload', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    const recorded = await store.record(killedRendererCrash())

    emitRendererBootstrapRendered()

    await expect(getLatestPending()).resolves.toMatchObject({ id: recorded.id, status: 'pending' })
  })

  it('still prompts when the recovery reload never brought the renderer back', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    const recorded = await store.record(killedRendererCrash())

    noteRendererRecoveryReloadIssued()

    await expect(getLatestPending()).resolves.toMatchObject({ id: recorded.id, status: 'pending' })
  })

  it('still prompts after the recovery breaker opened and the user reloaded by hand', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    // The crash-on-load loop: every recovery reload dies before bootstrap.
    const recorded = await store.record({ ...killedRendererCrash(), reason: 'launch-failed' })

    noteRendererRecoveryReloadIssued()
    // The breaker refuses the next attempt and Orca asks the user to retry.
    clearRendererRecoveryReloadIssued()
    // The user's own reload finally boots; it did not auto-recover anything.
    emitRendererBootstrapRendered()

    await expect(getLatestPending()).resolves.toMatchObject({ id: recorded.id, status: 'pending' })
    expect((await getLatestReport())?.details.rendererAutoRecovered).toBeUndefined()
  })

  it('leaves an unresolved crash from a previous session pending', async () => {
    const store = await createStore()
    registerCrashReportingHandlers(store)
    const recorded = await store.record(killedRendererCrash())

    const oneHourLater = Date.parse(recorded.createdAt) + 3_600_000
    noteRendererRecoveryReloadIssued(oneHourLater)
    resolveRecoveredRendererCrashReports(store, oneHourLater)

    await expect(getLatestPending()).resolves.toMatchObject({ id: recorded.id, status: 'pending' })
  })
})
