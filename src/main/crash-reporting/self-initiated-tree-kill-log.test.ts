import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.4.194-test',
    getAppMetrics: () => []
  }
}))

import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { resetProcessGoneSiblingCorrelationForTest } from './process-gone-sibling-correlation'
import {
  findSelfInitiatedTreeKills,
  installProcessTreeKillBreadcrumbObserver,
  recordRefusedOwnChromiumTreeKill,
  recordSelfInitiatedTreeKill,
  resetSelfInitiatedTreeKillLogForTest,
  selfInitiatedTreeKillDetails
} from './self-initiated-tree-kill-log'
import {
  notifyProcessTreeKill,
  setProcessTreeKillObserver
} from '../../shared/child-process/process-tree-kill-observer'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'

/** The field shape: renderer, `reason=killed exitCode=1`, win32 (#G2). */
function killedRendererEvent(): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'killed',
    exitCode: 1,
    expectedTeardown: 'none',
    details: { processType: 'renderer' }
  }
}

type RecordedReport = { details: Record<string, unknown> }

function capturingStore(recorded: RecordedReport[]) {
  return {
    record: async (report: RecordedReport) => {
      recorded.push(report)
      return { id: 'report-1' }
    },
    attachDetails: async () => null
  }
}

/** Drives one crash through the recorder and returns the persisted details. */
async function recordKilledRenderer(): Promise<Record<string, unknown>> {
  const recorded: RecordedReport[] = []
  recordProcessGoneCrash(
    capturingStore(recorded) as never,
    killedRendererEvent(),
    new ProcessGoneDedupe(),
    async () => null
  )
  await vi.waitFor(() => expect(recorded).toHaveLength(1))
  return recorded[0]!.details
}

beforeEach(() => {
  setActiveSink({ push: () => {}, flush: () => {}, close: () => {} })
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
  resetSelfInitiatedTreeKillLogForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  resetProcessGoneSiblingCorrelationForTest()
  resetSelfInitiatedTreeKillLogForTest()
})

describe('self-initiated tree kill breadcrumb', () => {
  it('separates an Orca-issued tree kill from an external kill of the same shape', async () => {
    // Arm A — Orca issues the kill through its own taskkill choke point.
    await terminateWindowsProcessTree(4242, {
      execFileImpl: ((_program, _args, _options, done) => {
        ;(done as () => void)()
        return undefined as never
      }) as never,
      site: 'pty-descendant-sweep'
    })
    const selfKilled = await recordKilledRenderer()

    resetSelfInitiatedTreeKillLogForTest()
    clearCrashBreadcrumbsForTest()

    // Arm B — identical crash, nobody inside Orca issued a kill.
    const externallyKilled = await recordKilledRenderer()

    expect(selfKilled.selfInitiatedKills).toMatch(
      /^win-taskkill-tree\/pty-descendant-sweep\/pid4242 [+-]\d+ms$/
    )
    expect(selfKilled.selfInitiatedTreeKillCount).toBe(1)
    expect(externallyKilled.selfInitiatedKills).toBeUndefined()
    expect(externallyKilled.selfInitiatedTreeKillCount).toBeUndefined()
    // Every other recorded field is identical — that is why the breadcrumb exists.
    expect({
      ...selfKilled,
      selfInitiatedKills: null,
      selfInitiatedTreeKillCount: null
    }).toEqual({
      ...externallyKilled,
      selfInitiatedKills: null,
      selfInitiatedTreeKillCount: null
    })
  })

  it('records a durable breadcrumb so the kill survives into the diagnostic bundle', async () => {
    await terminateWindowsProcessTree(777, {
      execFileImpl: ((_program, _args, _options, done) => {
        ;(done as () => void)()
        return undefined as never
      }) as never,
      site: 'codex-turn-added-roots'
    })

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'self_tree_kill',
        data: expect.objectContaining({
          pid: 777,
          site: 'codex-turn-added-roots',
          scope: 'win-taskkill-tree'
        })
      })
    ])
  })

  it('keeps only kills near the death and drops the rest of the ring', () => {
    const goneAt = 1_000_000
    recordSelfInitiatedTreeKill({
      pid: 1,
      site: 'a',
      scope: 'win-taskkill-tree',
      at: goneAt - 6_000
    })
    recordSelfInitiatedTreeKill({
      pid: 2,
      site: 'b',
      scope: 'posix-process-group',
      at: goneAt - 90
    })
    recordSelfInitiatedTreeKill({ pid: 3, site: 'c', scope: 'win-pty-job', at: goneAt + 500 })

    const nearby = findSelfInitiatedTreeKills(goneAt)

    expect(nearby.map((kill) => kill.pid)).toEqual([2])
    expect(selfInitiatedTreeKillDetails(goneAt).selfInitiatedKills).toBe(
      'posix-process-group/b/pid2 -90ms'
    )
  })

  it('bounds the ring at 32 entries', () => {
    const goneAt = 2_000_000
    for (let index = 0; index < 40; index += 1) {
      recordSelfInitiatedTreeKill({
        pid: index + 1,
        site: 'sweep',
        scope: 'win-taskkill-tree',
        at: goneAt - 10
      })
    }

    expect(findSelfInitiatedTreeKills(goneAt)).toHaveLength(32)
  })

  it('never lets routine teardown kills evict the refusal crumb from the ring', () => {
    // The reproduction from review: 12 terminal closes x 3 process groups.
    for (let close = 0; close < 12; close += 1) {
      for (let group = 0; group < 3; group += 1) {
        recordSelfInitiatedTreeKill({
          pid: 5_000 + close * 3 + group,
          site: 'posix-pty-process-group-sweep',
          scope: 'posix-process-group'
        })
      }
    }
    recordRefusedOwnChromiumTreeKill({
      pid: 4242,
      site: 'pty-descendant-sweep',
      scope: 'win-taskkill-tree'
    })
    recordCrashBreadcrumb('gpu_process_crashed')

    const names = getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.name)

    expect(names).toContain('self_tree_kill_refused_own_chromium')
    expect(names).toContain('gpu_process_crashed')
    expect(names.filter((name) => name === 'self_tree_kill')).toHaveLength(1)
  })

  it('keeps a pty-scoped sweep out of the count that means "we held the knife"', () => {
    const goneAt = 3_000_000
    recordSelfInitiatedTreeKill({
      pid: 1000,
      site: 'posix-pty-process-group-sweep',
      scope: 'posix-process-group',
      at: goneAt - 1
    })
    recordSelfInitiatedTreeKill({
      pid: 1001,
      site: 'posix-pty-process-group-sweep',
      scope: 'posix-process-group',
      at: goneAt - 2
    })

    const details = selfInitiatedTreeKillDetails(goneAt)

    // A killpg on a PTY's own groups cannot reach a renderer, so it must not
    // read as a self-inflicted renderer kill.
    expect(details.selfInitiatedTreeKillCount).toBeUndefined()
    expect(details.selfInitiatedGroupKillCount).toBe(2)
    expect(details.selfInitiatedKills).toContain('posix-process-group/')
  })

  it('lists a pid-addressed tree kill ahead of teardown noise so truncation keeps it', () => {
    const goneAt = 4_000_000
    for (let index = 0; index < 12; index += 1) {
      recordSelfInitiatedTreeKill({
        pid: 2000 + index,
        site: 'posix-pty-process-group-sweep',
        scope: 'posix-process-group',
        at: goneAt - 1
      })
    }
    recordSelfInitiatedTreeKill({
      pid: 9999,
      site: 'pty-descendant-sweep',
      scope: 'win-taskkill-tree',
      at: goneAt - 200
    })

    const details = selfInitiatedTreeKillDetails(goneAt)

    expect(details.selfInitiatedTreeKillCount).toBe(1)
    expect(String(details.selfInitiatedKills)).toMatch(
      /^win-taskkill-tree\/pty-descendant-sweep\/pid9999 -200ms/
    )
    expect(String(details.selfInitiatedKills)).toContain('more)')
  })

  it('records a kill issued through the shared runProcess choke point', () => {
    installProcessTreeKillBreadcrumbObserver()

    notifyProcessTreeKill({ pid: 3131, site: 'run-process-tree', scope: 'posix-process-group' })

    expect(findSelfInitiatedTreeKills(Date.now()).map((kill) => kill.pid)).toEqual([3131])
    setProcessTreeKillObserver(null)
  })
})
