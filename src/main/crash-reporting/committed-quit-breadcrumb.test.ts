import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearCrashBreadcrumbsForTest } from './crash-breadcrumb-store'
import {
  COMMITTED_QUIT_BREADCRUMB_NAME,
  recordCommittedQuitBreadcrumb,
  resolveCommittedQuitReason
} from './committed-quit-breadcrumb'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'

type CapturingSink = TracerSink & { records: unknown[] }

function capturingSink(): CapturingSink {
  const records: unknown[] = []
  return { records, push: (record) => records.push(record), flush: vi.fn(), close: vi.fn() }
}

let sink: CapturingSink

beforeEach(() => {
  sink = capturingSink()
  setActiveSink(sink)
  clearCrashBreadcrumbsForTest()
})

afterEach(() => {
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
})

const noQuitSignals = {
  quittingForUpdate: false,
  devParentShutdownRequested: false,
  systemSessionEnding: false
}

describe('resolveCommittedQuitReason', () => {
  it('names a plain quit', () => {
    expect(resolveCommittedQuitReason(noQuitSignals)).toBe('app-quit')
  })

  it('prefers the update install over a concurrent OS session end', () => {
    expect(
      resolveCommittedQuitReason({
        ...noQuitSignals,
        quittingForUpdate: true,
        systemSessionEnding: true
      })
    ).toBe('update-install')
  })

  it('names a dev-parent shutdown and an OS session end', () => {
    expect(resolveCommittedQuitReason({ ...noQuitSignals, devParentShutdownRequested: true })).toBe(
      'dev-parent-shutdown'
    )
    expect(resolveCommittedQuitReason({ ...noQuitSignals, systemSessionEnding: true })).toBe(
      'system-session-end'
    )
  })
})

describe('recordCommittedQuitBreadcrumb', () => {
  it('writes a durable crumb carrying this launch id, so the next launch can find it', () => {
    recordCommittedQuitBreadcrumb(noQuitSignals)

    // Exactly one crumb: an extra durable write here would make the next launch's
    // "did this launch commit a quit?" scan answer for the wrong event.
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'crash.breadcrumb',
        attributes: expect.objectContaining({
          'breadcrumb.name': COMMITTED_QUIT_BREADCRUMB_NAME,
          'breadcrumb.data': expect.objectContaining({
            quitReason: 'app-quit',
            mainProcessLaunchId: getMainProcessLifecycleIdentity().mainProcessLaunchId
          })
        })
      })
    ])
  })
})
