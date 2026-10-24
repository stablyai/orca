import * as mobileProjection from './runtime-mobile-session-projection'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { TerminalInterfaceAuthority } from '../agent-hooks/server/terminal-interface-authority'
import { withBoundPane } from './bind-first-pane.test-fixture'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
const {
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  TEST_WORKTREE_ID
} = await import('./orca-runtime-test-fixtures.spec')

async function population(size: number, allEligible = false) {
  const bindings = Array.from({ length: size }, (_, index) => ({
    ptyId: `pty-${index}`,
    tabId: randomUUID(),
    leafId: randomUUID(),
    worktreeId: `${TEST_WORKTREE_ID}-interface-${index}`,
    incarnationId: `birth-${index}`
  }))
  let session = makeWorkspaceSessionWithHeadlessTerminal({
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  })
  for (const binding of bindings) {
    session = withBoundPane(session, binding)
  }
  const store = makeRuntimeStoreWithWorkspaceSession(session)
  const authority = new TerminalInterfaceAuthority()
  const runtime = new OrcaRuntimeService(store.runtimeStore, undefined, {
    terminalInterfaces: authority
  })
  let shell = false
  let unrecognized = false
  let completionStagger = 0
  const inspect = vi.fn(async (ptyId: string) => {
    const capturedAt = performance.now()
    if (completionStagger) {
      await new Promise((resolve) =>
        setTimeout(resolve, Number(ptyId.slice('pty-'.length)) * completionStagger)
      )
    }
    return {
      foregroundProcess: unrecognized ? 'vim' : shell ? 'bash' : 'codex',
      hasChildProcesses: true,
      terminalInterface: {
        shellForeground: shell,
        children: 'children' as const,
        capturedAgeMs: performance.now() - capturedAt
      }
    }
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    inspectProcess: inspect
  })
  for (const [index, binding] of bindings.entries()) {
    runtime.registerPty(
      binding.ptyId,
      binding.worktreeId,
      null,
      binding,
      !allEligible && index !== 0
    )
    runtime['issuePtyHandle'](runtime['ptysById'].get(binding.ptyId)!)
  }
  await vi.advanceTimersByTimeAsync(250)
  await vi.advanceTimersByTimeAsync(1)
  expect(authority.snapshot()).toHaveLength(allEligible ? size : 1)
  expect(authority.read('pty-0', 'birth-0')?.state).toBe('agent')
  let inventoryVisits = 0
  const ptys = runtime['ptysById']
  const values = ptys.values.bind(ptys)
  vi.spyOn(ptys, 'values').mockImplementation(function* (): Generator<
    RuntimePtyWorktreeRecord,
    undefined,
    unknown
  > {
    for (const pty of values()) {
      inventoryVisits += 1
      yield pty
    }
  })
  const paneQueries = vi.fn(runtime['paneOfPty'].bind(runtime))
  runtime['paneOfPty'] = paneQueries
  const persist = vi.fn(runtime['persistClientHostedBrowserPagesForWorktree'].bind(runtime))
  runtime['persistClientHostedBrowserPagesForWorktree'] = persist
  const project = vi.spyOn(mobileProjection, 'projectRuntimeMobileSessionTabs')
  const browserReads = vi.spyOn(getRuntimeBrowserPageRegistry(runtime), 'listPages')
  const sessionReads = vi.spyOn(store.runtimeStore, 'getWorkspaceSession')
  const events: RuntimeClientEvent[] = []
  const offEvents = runtime.onClientEvent((event) => events.push(event))
  const measurements = () => ({
    inventoryVisits,
    paneQueries: paneQueries.mock.calls.length,
    inspections: inspect.mock.calls.length,
    browserReads: browserReads.mock.calls.length,
    persistenceRequests: persist.mock.calls.length,
    sessionReads: sessionReads.mock.calls.length,
    sessionWrites: store.runtimeStore.setWorkspaceSession.mock.calls.length,
    projections: project.mock.calls.length,
    snapshots: events.filter((event) => event.type === 'terminalInterfaces').length,
    observationEntries: events.reduce(
      (total, event) =>
        total + (event.type === 'terminalInterfaces' ? event.observations.length : 0),
      0
    )
  })
  const reset = () => {
    for (const mock of [paneQueries, inspect, persist, project, browserReads, sessionReads]) {
      mock.mockClear()
    }
    store.runtimeStore.setWorkspaceSession.mockClear()
    events.length = 0
    inventoryVisits = 0
  }
  reset()
  return {
    runtime,
    authority,
    bindings,
    events,
    measurements,
    reset,
    setRecognized: () => {
      unrecognized = false
    },
    setUnrecognized: (stagger = 0) => {
      unrecognized = true
      completionStagger = stagger
    },
    setShell: (value: boolean, input = true) => {
      shell = value
      if (input) {
        runtime['terminalRunFacts'].recordInput('pty-0', 'driving', 'x')
      }
    },
    stop: () => {
      offEvents()
      authority.stop()
    }
  }
}

async function measure<T>(
  size: number,
  run: (fixture: Awaited<ReturnType<typeof population>>) => Promise<T>,
  allEligible = false
) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  const fixture = await population(size, allEligible)
  try {
    return await run(fixture)
  } finally {
    fixture.stop()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  }
}

type Measurements = ReturnType<Awaited<ReturnType<typeof population>>['measurements']>

it('bounds unchanged 250ms inventory and one-terminal input work by observed terminals', async () => {
  const results: { size: number; tick: Measurements; input: Measurements }[] = []
  for (const size of [10, 100]) {
    results.push(
      await measure(size, async (fixture) => {
        await vi.advanceTimersByTimeAsync(250)
        const tick = fixture.measurements()
        expect(tick.inspections).toBe(0)
        expect(tick.snapshots).toBe(0)
        fixture.reset()
        fixture.setShell(false)
        return { size, tick, input: fixture.measurements() }
      })
    )
  }
  process.stdout.write(`INTERFACE_OPERATION_BOUND inventory ${JSON.stringify(results)}\n`)
  expect(results[1]!.tick.paneQueries).toBeLessThanOrEqual(results[0]!.tick.paneQueries + 2)
  expect(results[1]!.input.paneQueries).toBeLessThanOrEqual(results[0]!.input.paneQueries + 2)
  for (const { tick, input } of results) {
    expect(tick.sessionReads).toBeLessThanOrEqual(1)
    expect(input.sessionReads).toBeLessThanOrEqual(1)
    expect(input.inspections).toBe(0)
    expect(input.snapshots).toBe(0)
  }
})

it('bounds full snapshot work by observations rather than unrelated panes', async () => {
  const results: (Measurements & { size: number })[] = []
  for (const size of [10, 100]) {
    results.push(
      await measure(size, async (fixture) => {
        const snapshot = fixture.runtime.getTerminalInterfaceClientEventSnapshot()
        expect(snapshot).toMatchObject([
          { type: 'terminalInterfaces', observations: [{ ptyId: 'pty-0', state: 'agent' }] }
        ])
        expect(snapshot[0]?.type === 'terminalInterfaces' && snapshot[0].observations).toHaveLength(
          1
        )
        expect(fixture.measurements().snapshots).toBe(0)
        return { size, ...fixture.measurements() }
      })
    )
  }
  process.stdout.write(`INTERFACE_OPERATION_BOUND snapshot ${JSON.stringify(results)}\n`)
  expect(results[1]!.paneQueries).toBeLessThanOrEqual(results[0]!.paneQueries + 2)
  for (const result of results) {
    expect(result.sessionReads).toBeLessThanOrEqual(1)
    expect(result.inspections).toBe(0)
  }
})

it('bounds one observation change and recovery fanout by affected mobile workspaces', async () => {
  const results: {
    size: number
    withoutListener: Measurements
    recovered: Measurements
    retracted: Measurements
  }[] = []
  for (const size of [10, 100]) {
    results.push(
      await measure(size, async (fixture) => {
        const { runtime, bindings } = fixture
        runtime['mobileSessionTabsByWorktree'].clear()
        for (const binding of bindings) {
          runtime['mobileSessionTabsByWorktree'].set(binding.worktreeId, {
            worktree: binding.worktreeId,
            publicationEpoch: 'renderer:operation-bound',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'terminal',
                id: `${binding.tabId}::${binding.leafId}`,
                parentTabId: binding.tabId,
                leafId: binding.leafId,
                ptyId: binding.ptyId,
                title: 'Agent',
                isActive: true
              },
              {
                type: 'browser',
                id: `browser-${binding.ptyId}`,
                browserWorkspaceId: binding.worktreeId,
                browserPageId: `page-${binding.ptyId}`,
                title: 'Preserve browser',
                url: 'https://example.test/',
                loading: false,
                canGoBack: false,
                canGoForward: false,
                isActive: false
              }
            ]
          })
        }
        const ordinary = runtime['mobileSessionTabsByWorktree'].get(bindings[0]!.worktreeId)!
        const ordinaryDelivered = vi.fn()
        const offOrdinary = runtime.onMobileSessionTabsChanged(ordinaryDelivered)
        const pages = getRuntimeBrowserPageRegistry(runtime)
        const pageId = `page-${bindings[0]!.ptyId}`
        const placement = {
          kind: 'client' as const,
          browserHostClientId: 'phone',
          browserHostGeneration: 1,
          pageHostGeneration: 1
        }
        pages.publishClientPage({
          browserPageId: pageId,
          workspaceId: bindings[0]!.worktreeId,
          browserProfileId: 'profile',
          executionHostKey: 'native:test:1',
          placement,
          url: 'https://new.test/',
          title: 'Current metadata',
          loading: false,
          active: false
        })
        runtime['emitMobileSessionTabsSnapshot'](ordinary)
        expect(ordinaryDelivered.mock.calls.at(-1)?.[0].tabs[1]).toMatchObject({
          type: 'browser',
          title: 'Current metadata',
          url: 'https://new.test/'
        })
        pages.retirePage(pageId, placement)
        ordinaryDelivered.mockClear()
        runtime['emitMobileSessionTabsSnapshot'](ordinary)
        expect(ordinaryDelivered).toHaveBeenCalledOnce()
        expect(
          ordinaryDelivered.mock.calls[0][0].tabs.some(
            (tab: { type: string }) => tab.type === 'browser'
          )
        ).toBe(false)
        const acceptedBrowserFrame = ordinaryDelivered.mock.calls[0][0]
        const changeSequence = runtime['mobileSessionTabsChangeSequence']
        offOrdinary()
        fixture.setShell(true)
        fixture.reset()
        await vi.advanceTimersByTimeAsync(1750)
        const withoutListener = fixture.measurements()
        expect(withoutListener.snapshots).toBe(1)
        expect(withoutListener.projections).toBe(0)
        expect(fixture.authority.snapshot()).toMatchObject([{ state: 'shell' }])
        expect(
          runtime.mobileSessionTabsByWorktree.get(bindings[0]!.worktreeId)?.snapshotVersion
        ).toBe(1)
        expect(
          runtime.mobileSessionTabsByWorktree.get(bindings[1]!.worktreeId)?.snapshotVersion
        ).toBe(1)
        const delivered =
          vi.fn<(snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void>()
        const off = runtime.onMobileSessionTabsChanged(delivered)
        try {
          fixture.setShell(false)
          fixture.reset()
          await vi.advanceTimersByTimeAsync(250)
          const recovered = fixture.measurements()
          expect(recovered.snapshots).toBe(1)
          expect(runtime['mobileSessionTabsChangeSequence']).toBe(changeSequence)
          expect(
            acceptedBrowserFrame.tabs.some((tab: { type: string }) => tab.type === 'browser')
          ).toBe(false)
          expect(delivered).not.toHaveBeenCalled()
          expect(
            runtime.mobileSessionTabsByWorktree.get(bindings[0]!.worktreeId)?.snapshotVersion
          ).toBe(1)
          fixture.reset()
          delivered.mockClear()
          await vi.advanceTimersByTimeAsync(250)
          expect(delivered).not.toHaveBeenCalled()
          expect(fixture.measurements().persistenceRequests).toBe(0)
          fixture.reset()
          fixture.authority.stop()
          const retracted = fixture.measurements()
          expect(fixture.events).toMatchObject([{ type: 'terminalInterfaces', observations: [] }])
          expect(runtime['mobileSessionTabsChangeSequence']).toBe(changeSequence)
          expect(
            acceptedBrowserFrame.tabs.some((tab: { type: string }) => tab.type === 'browser')
          ).toBe(false)
          expect(delivered).not.toHaveBeenCalled()
          expect(
            runtime.mobileSessionTabsByWorktree.get(bindings[0]!.worktreeId)?.snapshotVersion
          ).toBe(1)
          return { size, withoutListener, recovered, retracted }
        } finally {
          off()
        }
      })
    )
  }
  process.stdout.write(`INTERFACE_OPERATION_BOUND mobile ${JSON.stringify(results)}\n`)
  for (const { withoutListener, recovered, retracted } of results) {
    for (const phase of [withoutListener, recovered, retracted]) {
      expect(phase.persistenceRequests).toBe(0)
      expect(phase.browserReads).toBe(0)
      expect(phase.sessionWrites).toBe(0)
      expect(phase.paneQueries).toBeLessThanOrEqual(20)
      expect(phase.sessionReads).toBeLessThanOrEqual(20)
    }
    expect(recovered.projections).toBe(0)
    expect(retracted.projections).toBe(0)
  }
})

it.each([0, 2])(
  'bounds all-eligible completion and full-frame work (completion stagger=%sms)',
  async (stagger) => {
    const results: { size: number; stagger: number; tick: Measurements; wave: Measurements }[] = []
    for (const size of [10, 100]) {
      results.push(
        await measure(
          size,
          async (fixture) => {
            const structuralVersion = fixture.runtime['mobileSessionTabsChangeSequence']
            await vi.advanceTimersByTimeAsync(250)
            const tick = fixture.measurements()
            fixture.reset()
            fixture.setUnrecognized(stagger)
            await vi.advanceTimersByTimeAsync(750)
            const wave = fixture.measurements()
            expect(fixture.authority.snapshot().every((row) => row.state === 'unverifiable')).toBe(
              true
            )
            expect(fixture.runtime['mobileSessionTabsChangeSequence']).toBe(structuralVersion)
            for (const counters of [tick, wave]) {
              expect(counters.browserReads).toBe(0)
              expect(counters.persistenceRequests).toBe(0)
              expect(counters.sessionWrites).toBe(0)
              expect(counters.projections).toBe(0)
            }
            fixture.setRecognized()
            await vi.advanceTimersByTimeAsync(850)
            const replay = fixture.runtime.getTerminalInterfaceClientEventSnapshot()[0]
            expect(replay?.type === 'terminalInterfaces' && replay.observations).toHaveLength(size)
            if (stagger && size === 100 && replay?.type === 'terminalInterfaces') {
              expect(new Set(replay.observations.map((row) => row.state)).size).toBe(2)
            }
            fixture.reset()
            fixture.authority.stop()
            expect(fixture.events).toMatchObject([{ type: 'terminalInterfaces', observations: [] }])
            fixture.runtime['installTerminalInterfaceHost']()
            expect(fixture.runtime.getTerminalInterfaceClientEventSnapshot()).toMatchObject([
              { type: 'terminalInterfaces', observations: [] }
            ])
            await vi.advanceTimersByTimeAsync(1250)
            expect(fixture.events.length).toBeGreaterThanOrEqual(2)
            expect(fixture.events.length).toBeLessThanOrEqual(7)
            expect(fixture.events[0]).toMatchObject({
              type: 'terminalInterfaces',
              observations: []
            })
            for (const event of fixture.events.slice(1)) {
              expect(
                event.type === 'terminalInterfaces' &&
                  event.observations.every((row) => row.state === 'agent')
              ).toBe(true)
            }
            const recovered = fixture.events.at(-1)
            expect(recovered?.type === 'terminalInterfaces' && recovered.observations).toHaveLength(
              size
            )
            expect(fixture.authority.snapshot().every((row) => row.state === 'agent')).toBe(true)
            return { size, stagger, tick, wave }
          },
          true
        )
      )
    }
    process.stdout.write(`INTERFACE_OPERATION_BOUND allEligible ${JSON.stringify(results)}\n`)
    expect(results[1]!.wave.inventoryVisits).toBeLessThanOrEqual(
      results[0]!.wave.inventoryVisits * 10
    )
    expect(results[1]!.wave.paneQueries).toBeLessThanOrEqual(results[0]!.wave.paneQueries * 10)
    expect(results[1]!.wave.sessionReads).toBeLessThanOrEqual(results[0]!.wave.sessionReads * 10)
    for (const { size, wave } of results) {
      expect(wave.snapshots).toBe(1)
      expect(wave.observationEntries).toBe(size)
    }
  }
)
