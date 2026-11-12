import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import { captureWorktreeTerminalStops } from '../../terminal/stop/worktree-terminal-removal-snapshot'
import { OrcaRuntimeWithStopTerminalsForWorktree } from '../../terminal/stop/worktree-terminal-stop'
import { killAllProcessesForWorktrees } from './worktree-batch-teardown'
import type { WorktreeTeardownRuntime } from './worktree-teardown'
import * as registry from '../../../memory/pty-registry'

const hostRef: { current: unknown } = { current: null }
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('../../terminal/launch/terminal-split-source-authority', () => ({
  OrcaRuntimeWithResolveTerminalSplitSourceAuthority: class {}
}))
afterEach(() => {
  hostRef.current = null
  vi.restoreAllMocks()
})

async function measure(
  count: number,
  unrelated: number,
  replacement?: 'host' | 'incarnation',
  leaseFailure = false,
  perTarget = 1,
  exitObserved = true,
  disconnected = false
) {
  const targets = Array.from({ length: count }, (_, i) => ({
    worktreeId: `folder:${i}`,
    connectionId: null
  }))
  const rows: PtyProcessInfo[] = Array.from({ length: count * perTarget + unrelated }, (_, i) => ({
    id: `folder:${Math.floor(i / perTarget)}@@pty${i % perTarget || ''}`,
    worktreeId: `folder:${Math.floor(i / perTarget)}`,
    incarnationId: `inc-${i}`,
    title: 'shell',
    cwd: '/scratch'
  }))
  const records = new Map(
    rows.map((row) => [
      row.id,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown reads only the ownership fields supplied by this fixture.
      {
        incarnationId: row.incarnationId,
        ptyId: row.id,
        worktreeId: row.worktreeId!,
        connectionId: null,
        connected: !disconnected || row !== rows[0]
      } as RuntimePtyWorktreeRecord
    ])
  )
  const visits = {
    graph: 0,
    provider: 0,
    registry: 0,
    structured: 0,
    stops: 0,
    reads: 0,
    exits: 0,
    clears: 0
  }
  const incarnationById = new Map(rows.map((row) => [row.id, row.incarnationId]))
  const get = records.get.bind(records)
  records.get = (id) => {
    visits.reads++
    return get(id)
  }
  const iterate = function* <T>(values: Iterable<T>, kind: keyof typeof visits) {
    for (const value of values) {
      visits[kind]++
      yield value
    }
  }
  const originalValues = records.values.bind(records)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generator preserves Map iteration and only counts yielded rows.
  records.values = () => iterate(originalValues(), 'graph') as MapIterator<RuntimePtyWorktreeRecord>
  const leafRows = rows
    .filter((row) => !disconnected || row !== rows[0])
    .map((row) => ({ worktreeId: row.worktreeId!, ptyId: row.id }))
  const listedRegistry = vi.spyOn(registry, 'listRegisteredPtys').mockImplementation(() => [
    ...iterate(
      rows.map((row) => ({
        ptyId: row.id,
        worktreeId: row.worktreeId!,
        sessionId: null,
        paneKey: null,
        pid: null
      })),
      'registry'
    )
  ])
  const conversations = rows.map((row) => ({
    location: { workspaceId: `other:${row.id}`, executionHostId: 'local' }
  }))
  const listConversations = vi.fn(() => [...iterate(conversations, 'structured')])
  hostRef.current = { deps: { store: { listConversations } } }
  const live = new Map(rows.map((row) => [row.id, row]))
  const listProcesses = vi.fn(async (options?: { ptyIds?: string[] }) => {
    if (!options?.ptyIds && replacement) {
      Object.assign(
        records.get('folder:0@@pty')!,
        replacement === 'host'
          ? { worktreeId: 'folder:other', connectionId: 'other-host' }
          : { incarnationId: 'replacement' }
      )
    }
    const result = options?.ptyIds
      ? options.ptyIds.flatMap((id) => (live.has(id) ? [live.get(id)!] : []))
      : [...live.values()]
    return [...iterate(result, 'provider')]
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production sweep uses only these provider methods.
  const provider = {
    listProcesses,
    shutdown: async (id: string) => {
      visits.stops++
      live.delete(id)
    }
  } as unknown as IPtyProvider
  const graph = {
    ptysById: records,
    captureReadyGraphEpoch: () => 1,
    assertStableReadyGraph: () => {},
    ptyController: {
      stopAndWait: async (id: string) => {
        visits.stops++
        live.delete(id)
        return true
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime port reached by the batch sweep.
  const runtime = {
    captureWorktreeTerminalStops: () =>
      captureWorktreeTerminalStops(targets, {
        acquire: async (id) => {
          if (leaseFailure && id === 'folder:0') {
            throw new Error('lease timed out')
          }
          return () => {}
        },
        captureFence: () => () => {},
        leaves: () => iterate(leafRows, 'graph'),
        ptys: records
      }),
    stopTerminalsForWorktree: (id, options) =>
      OrcaRuntimeWithStopTerminalsForWorktree.prototype.stopTerminalsForWorktree.call(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the stop method’s graph and controller ports.
        graph as never,
        id,
        options
      ),
    getPtyLivenessVerdict: (id) =>
      exitObserved ? { status: 'exited', incarnationId: incarnationById.get(id) } : null,
    waitForPtyExitRetirement: async () => true,
    onPtyExit: () => {
      visits.exits++
    },
    retireStructuredAgentSessionTabFromSnapshot: () => true,
    currentLocalStructuredSessionPresentation: () => null,
    captureStructuredAgentSessionPresentation: () => ({ raw: null, saved: [] }),
    removeCapturedStructuredSessionSavedTabs: () => undefined
  } as WorktreeTeardownRuntime
  const outcomes = await killAllProcessesForWorktrees(targets, {
    runtime,
    localProvider: provider,
    onPtyStopped: () => {
      visits.clears++
    }
  })
  if (replacement) {
    expect([...outcomes.values()]).toEqual([false])
    expect(visits.stops).toBe(0)
    expect(live.size).toBe(count + unrelated)
    listedRegistry.mockRestore()
    return visits
  }
  expect([...outcomes.values()]).toEqual(
    Array.from({ length: count }, (_, i) => !leaseFailure || i !== 0)
  )
  expect(live.size).toBe(unrelated)
  // Required output: discover each authority once, then stop exactly the N selected PTYs.
  expect(listProcesses).toHaveBeenCalledTimes(2)
  expect(listedRegistry).toHaveBeenCalledOnce()
  expect(listConversations).toHaveBeenCalledTimes(2)
  const selected = count * perTarget
  const population = selected + unrelated
  // Two capture lookups per population, then at most four keyed fence checks per selected stop.
  expect(visits.reads).toBeLessThanOrEqual(2 * population + 4 * selected)
  expect({ ...visits, reads: 0 }).toEqual({
    graph: 2 * population - (disconnected ? 1 : 0),
    provider: population,
    registry: population,
    structured: 2 * population,
    stops: selected,
    reads: 0,
    exits: exitObserved ? 0 : selected,
    clears: selected
  })
  listedRegistry.mockRestore()
  return visits
}

describe('bulk folder teardown population bound', () => {
  it.each([false, true])(
    'shares one retirement deadline while ready siblings progress (observed: %s)',
    async (observed) => {
      vi.useFakeTimers()
      const ids = Array.from({ length: 72 }, (_, i) => `folder:deadline@@${i}`)
      const rows = ids.map((id) => ({
        id,
        incarnationId: id,
        worktreeId: 'folder:deadline',
        cwd: '',
        title: ''
      }))
      let live = true
      const clears: string[] = []
      const exit = vi.fn((id: string) =>
        ids.indexOf(id) < 64 ? new Promise<void>(() => {}) : undefined
      )
      vi.spyOn(registry, 'listRegisteredPtys').mockReturnValue([])
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deadline fixture supplies the exact retirement and snapshot ports exercised by this batch.
      const runtime = {
        captureWorktreeTerminalStops: async () => ({
          snapshots: new Map([
            [
              '[null,"folder:deadline"]',
              { ptyIds: new Set(), records: new Map(), assertCurrent: () => {} }
            ]
          ]),
          finish: () => {}
        }),
        stopTerminalsForWorktree: async () => ({ stopped: 0 }),
        getPtyLivenessVerdict: (id: string) =>
          observed ? { status: 'exited', incarnationId: id } : null,
        waitForPtyExitRetirement: (id: string) =>
          ids.indexOf(id) < 64 ? new Promise<boolean>(() => {}) : Promise.resolve(true),
        onPtyExit: exit,
        captureStructuredAgentSessionPresentation: () => ({ raw: null, saved: [] }),
        currentLocalStructuredSessionPresentation: () => null,
        removeCapturedStructuredSessionSavedTabs: () => {},
        retireStructuredAgentSessionTabFromSnapshot: () => true
      } as WorktreeTeardownRuntime
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the only provider methods used by the batch fixture.
      const provider = {
        listProcesses: async () => (live ? rows : []),
        shutdown: async () => {
          live = false
        }
      } as unknown as IPtyProvider
      try {
        const pending = killAllProcessesForWorktrees(
          [{ worktreeId: 'folder:deadline', connectionId: null }],
          {
            runtime,
            localProvider: provider,
            onPtyStopped: (id) => {
              clears.push(id)
            }
          }
        )
        await vi.advanceTimersByTimeAsync(10_000)
        expect([...(await pending).values()]).toEqual([false])
        expect(clears).toEqual(observed ? ids.slice(64) : [])
        expect(exit).toHaveBeenCalledTimes(observed ? 0 : 32)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('keeps best-effort stops for every target when one mutation lease is unavailable', async () => {
    await measure(2, 1, undefined, true)
  })

  it.each(['host', 'incarnation'] as const)(
    'does not stop a same-object PTY replaced by %s after discovery',
    async (replacement) => {
      await measure(1, 1, replacement)
    }
  )

  it('stops a provider-only candidate with a disconnected runtime row', async () => {
    await measure(1, 1, undefined, false, 1, false, true)
  })

  it('uses keyed fences and avoids duplicate exit lifecycles as PTYs within one folder grow', async () => {
    await measure(1, 100, undefined, false, 10)
    await measure(1, 1000, undefined, false, 100)
    await measure(1, 1000, undefined, false, 100, false)
  })

  it('continues SSH sibling stops after an earlier candidate changes incarnation', async () => {
    const targets = [{ worktreeId: 'folder:ssh', connectionId: 'qa/host' }]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture/stop use only these ownership fields.
    const records = new Map(
      ['first', 'second'].map((id) => [
        id,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SSH fixture supplies only captured ownership fields read by stop.
        {
          ptyId: id,
          worktreeId: 'folder:ssh',
          connectionId: 'qa/host',
          connected: true,
          incarnationId: `inc-${id}`
        } as RuntimePtyWorktreeRecord
      ])
    )
    const capture = await captureWorktreeTerminalStops(targets, {
      acquire: async () => () => {},
      captureFence: () => () => {},
      leaves: () => [],
      ptys: records
    })
    const stopped: string[] = []
    const graph = {
      ptysById: records,
      captureReadyGraphEpoch: () => 1,
      assertStableReadyGraph: () => {},
      ptyController: {
        stopAndWait: async (id: string) => {
          stopped.push(id)
          if (id === 'first') {
            records.set(id, { ...records.get(id)!, incarnationId: 'replacement' })
          }
          return id === 'second'
        }
      }
    }
    const snapshot = [...capture.snapshots.values()][0]
    await OrcaRuntimeWithStopTerminalsForWorktree.prototype.stopTerminalsForWorktree.call(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production stop method reaches only the graph/controller ports supplied here.
      graph as never,
      'folder:ssh',
      { resolvedWorktreeId: 'folder:ssh', resolvedConnectionId: 'qa/host', snapshot }
    )
    expect(stopped).toEqual(['first', 'second'])
    capture.finish()
  })

  it('cleans independently certified provider state when graph and final inventory are unavailable', async () => {
    vi.spyOn(registry, 'listRegisteredPtys').mockReturnValue([])
    let calls = 0
    const provider = {
      listProcesses: async () => {
        if (++calls > 1) {
          throw new Error('inventory unavailable')
        }
        return [
          {
            id: 'folder:orphan@@pty',
            worktreeId: 'folder:orphan',
            incarnationId: 'orphan-inc',
            title: 'shell',
            cwd: '/scratch'
          }
        ]
      },
      supportsFencedTermination: () => true,
      killFenced: async () => ({ outcome: 'ended' }),
      onExit: () => () => {}
    }
    const clear = vi.fn()
    const exit = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this intentionally unavailable graph has only a provider-owned candidate.
    const runtime = {
      captureStructuredAgentSessionPresentation: () => ({ raw: null, saved: [] }),
      currentLocalStructuredSessionPresentation: () => null,
      removeCapturedStructuredSessionSavedTabs: () => {},
      retireStructuredAgentSessionTabFromSnapshot: () => true,
      captureWorktreeTerminalStops: async () => {
        throw new Error('graph unavailable')
      },
      stopTerminalsForWorktree: async () => ({ stopped: 0 }),
      getPtyLivenessVerdict: () => null,
      onPtyExit: exit
    } as WorktreeTeardownRuntime
    const result = await killAllProcessesForWorktrees(
      [{ worktreeId: 'folder:orphan', connectionId: null }],
      {
        runtime,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these controlled provider ports are reached.
        localProvider: provider as unknown as IPtyProvider,
        onPtyStopped: clear
      }
    )
    expect([...result.values()]).toEqual([false])
    expect(clear).toHaveBeenCalledExactlyOnceWith('folder:orphan@@pty')
    expect(exit).toHaveBeenCalledExactlyOnceWith('folder:orphan@@pty', 0, 'orphan-inc', {
      hostExitConfirmed: true
    })
  })

  it('discovers each authority once as targets and unrelated populations grow independently', async () => {
    const small = await measure(10, 100)
    const manyTargets = await measure(100, 100)
    const manyUnrelated = await measure(10, 1000)
    expect(manyTargets.stops).toBe(100)
    expect(manyUnrelated.stops).toBe(small.stops)
    expect(manyUnrelated.graph - small.graph).toBe(1800)
  })
})
