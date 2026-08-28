import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: () => []
  }
}))

import { clearCrashBreadcrumbsForTest } from './crash-breadcrumb-store'
import {
  markSystemSessionEnding,
  resetExpectedTeardownStateForTest,
  resolveExpectedTeardownScope,
  WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
} from './expected-teardown-state'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { resetProcessGoneSiblingCorrelationForTest } from './process-gone-sibling-correlation'

const noMinidump = async () => null
const attachDetails = async () => null

function event(overrides: Partial<ProcessGoneCrashEvent> = {}): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'killed',
    exitCode: 1,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    ...overrides
  }
}

const gpuKill = event({
  source: 'child',
  processType: 'GPU',
  details: { serviceName: 'GPU', type: 'GPU' }
})
const networkServiceKill = event({
  source: 'child',
  processType: 'Utility',
  details: {
    name: 'Network Service',
    serviceName: 'network.mojom.NetworkService',
    type: 'Utility'
  }
})
const rendererKill = event()

function currentTeardownScope() {
  return resolveExpectedTeardownScope({
    isQuitting: false,
    isQuittingForUpdate: false,
    isExpectedRendererReload: false
  })
}

let now: number

beforeEach(() => {
  now = 1_000
  resetExpectedTeardownStateForTest(() => now)
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetExpectedTeardownStateForTest()
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
})

describe('recordProcessGoneCrash killed/1 ordering', () => {
  it('reports a genuine lone renderer killed/1 without teardown intent', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash({ record } as never, rendererKill, new ProcessGoneDedupe())

    expect(record).toHaveBeenCalledOnce()
  })

  it('reports R3 after matching recoverable sibling churn', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const dedupe = new ProcessGoneDedupe()

    recordProcessGoneCrash({ record } as never, gpuKill, dedupe)
    recordProcessGoneCrash({ record } as never, networkServiceKill, dedupe)
    recordProcessGoneCrash({ record, attachDetails } as never, rendererKill, dedupe, noMinidump)

    expect(record).toHaveBeenCalledOnce()
    // Timing proximity is evidence, not authority to discard an ambiguous report.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        // Co-victims of one external tree kill: the label names the evidence
        // (these died together), not a sibling that caused anything.
        details: expect.objectContaining({
          crashAttribution: 'concurrent-process-deaths',
          siblingProcessDeathCount: 2
        }),
        breadcrumbs: expect.arrayContaining([
          expect.objectContaining({
            name: 'process_gone_suppressed',
            data: expect.objectContaining({ source: 'child', processType: 'GPU' })
          }),
          expect.objectContaining({
            name: 'process_gone_suppressed',
            data: expect.objectContaining({
              source: 'child',
              serviceName: 'network.mojom.NetworkService'
            })
          })
        ])
      })
    )
  })

  it('suppresses the fleet sequence only after independent session-end intent', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const dedupe = new ProcessGoneDedupe()
    markSystemSessionEnding()
    const expectedTeardown = currentTeardownScope()

    recordProcessGoneCrash({ record } as never, event({ ...gpuKill, expectedTeardown }), dedupe)
    recordProcessGoneCrash(
      { record } as never,
      event({ ...networkServiceKill, expectedTeardown }),
      dedupe
    )
    recordProcessGoneCrash(
      { record } as never,
      event({ ...rendererKill, expectedTeardown }),
      dedupe
    )

    expect(expectedTeardown).toBe('app-shutdown')
    expect(record).not.toHaveBeenCalled()
  })

  it('durably reports killed/1 after the session-end window expires', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    markSystemSessionEnding()
    now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
    const expectedTeardown = currentTeardownScope()

    recordProcessGoneCrash(
      { record } as never,
      event({ ...rendererKill, expectedTeardown }),
      new ProcessGoneDedupe()
    )

    expect(expectedTeardown).toBe('none')
    expect(record).toHaveBeenCalledOnce()
  })

  it('keeps a renderer report filed when session-end intent arrives later', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const scopeBeforeSessionEnd = currentTeardownScope()

    recordProcessGoneCrash(
      { record } as never,
      event({ ...rendererKill, expectedTeardown: scopeBeforeSessionEnd }),
      new ProcessGoneDedupe()
    )
    markSystemSessionEnding()
    const scopeAfterSessionEnd = currentTeardownScope()
    recordProcessGoneCrash(
      { record } as never,
      event({ ...rendererKill, expectedTeardown: scopeAfterSessionEnd }),
      new ProcessGoneDedupe()
    )

    expect(scopeBeforeSessionEnd).toBe('none')
    expect(scopeAfterSessionEnd).toBe('app-shutdown')
    expect(record).toHaveBeenCalledOnce()
  })
})
