import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'
import { createWaitBlockedCheckState } from './wait-blocked-check-state'

const sourceId = toAppSshPtyId('source', 'pty')
const otherId = toAppSshPtyId('other', 'pty')
const leafId = '11111111-1111-4111-8111-111111111111'
const restoredSource = [
  {
    ptyId: sourceId,
    incarnationId: 'source',
    surfaceBinding: {
      executionHostId: 'local',
      workspaceKey: 'folder:source',
      tabId: 'source',
      leafId,
      ptyId: 'pty'
    }
  }
]
class Runtime extends OrcaRuntimeService {
  seedObservationTimer(ptyId: string, callback: () => void) {
    const state = createWaitBlockedCheckState()
    state.timer = setTimeout(callback, 60_000)
    this.waitBlockedCheckStateByPtyId.set(ptyId, state)
  }
  queueMobile(worktreeId: string) {
    this.scheduleMobileSessionTabsChanged(worktreeId)
  }
  seedMobile(host: string, ptyId: string) {
    this.storeMobileSessionSnapshot(`folder:${host}`, {
      worktree: `folder:${host}`,
      publicationEpoch: 'renderer',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: [
        {
          type: 'terminal',
          id: `${host}::${leafId}`,
          parentTabId: host,
          leafId,
          ptyId,
          title: host,
          isActive: false
        }
      ]
    })
  }
  driftSourceSequence() {
    this.ptyOutputSequenceById.set(sourceId, this.getPtyOutputSequence(sourceId) + 1)
  }
  override rejectWaitersForHandle(handle: string, reason: string) {
    return super.rejectWaitersForHandle(handle, reason)
  }
  inspect() {
    return {
      models: this.headlessTerminals,
      leaves: this.leaves,
      ptys: this.ptysById,
      handles: this.handles,
      byPty: this.handleByPtyId,
      byLeaf: this.handleByLeafKey,
      indexed: this.leavesByPtyId,
      synthetic: this.syntheticTerminalHandles,
      tabs: this.tabs,
      mobile: this.mobileSessionTabsByWorktree,
      titles: this.ptyTitleTrackersByPtyId,
      waitChecks: this.waitBlockedCheckStateByPtyId
    }
  }
}
async function fixture() {
  const runtime = new Runtime()
  for (const [id, host] of [
    [sourceId, 'source'],
    [otherId, 'other']
  ]) {
    runtime.registerPty(id, `folder:${host}`, host, { tabId: host, leafId, incarnationId: host })
    runtime.preAllocateHandleForPty(id)
    await runtime.acceptPtyDataBounded(id, 'retained\r\n', Date.now()).completion
  }
  runtime.syncWindowGraph(1, {
    tabs: ['source', 'other'].map((host) => ({
      tabId: host,
      worktreeId: `folder:${host}`,
      title: host,
      activeLeafId: leafId,
      layout: null
    })),
    leaves: [
      [sourceId, 'source'],
      [otherId, 'other']
    ].map(([id, host]) => ({
      tabId: host,
      worktreeId: `folder:${host}`,
      leafId,
      paneRuntimeId: 1,
      ptyId: id
    }))
  })
  runtime.seedMobile('source', sourceId)
  runtime.seedMobile('other', otherId)
  return { runtime, signal: new AbortController().signal }
}

it('cleans an exact disconnected restored cohort without reporting remote exit', async () => {
  const { runtime, signal } = await fixture()
  const state = runtime.inspect()
  state.ptys.get(sourceId)!.connected = false
  const exit = vi.spyOn(runtime, 'onPtyExit')
  const other = state.models.get(otherId)
  expect(() => runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')).toThrow(
    'surface_changed'
  )
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source', restoredSource)
  await cleanup.remove(() => {}, signal)
  expect(state.ptys.has(sourceId)).toBe(false)
  expect(state.models.has(sourceId)).toBe(false)
  expect(state.models.get(otherId)).toBe(other)
  expect(() => runtime.bindOutgoingSshPtySurfaceAbsence('source', restoredSource)).not.toThrow()
  expect(exit).not.toHaveBeenCalled()
})

it.each(['incarnation', 'workspace', 'missing', 'duplicate'] as const)(
  'rejects %s restored-cohort mismatch before disposing models',
  async (kind) => {
    const { runtime } = await fixture()
    const model = runtime.inspect().models.get(sourceId)!
    const dispose = vi.spyOn(model.emulator, 'dispose')
    const saved = structuredClone(restoredSource)
    if (kind === 'incarnation') {
      saved[0].incarnationId = 'replacement'
    }
    if (kind === 'workspace') {
      saved[0].surfaceBinding.workspaceKey = 'folder:other'
    }
    if (kind === 'missing') {
      saved.pop()
    }
    if (kind === 'duplicate') {
      saved.push(saved[0])
    }
    expect(() => runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source', saved)).toThrow(
      'restored_catalog_mismatch'
    )
    expect(dispose).not.toHaveBeenCalled()
    expect(runtime.inspect().models.get(sourceId)).toBe(model)
  }
)

it('retires source records after surface cleanup without mutating or exiting the live process', async () => {
  const { runtime, signal } = await fixture()
  const state = runtime.inspect()
  const source = state.ptys.get(sourceId)!
  const sourceBefore = structuredClone(source)
  const otherModel = state.models.get(otherId)
  const handle = state.byPty.get(sourceId)!
  const otherSnapshot = state.mobile.get('folder:other')
  const exit = vi.spyOn(runtime, 'onPtyExit')
  const reject = vi.spyOn(runtime, 'rejectWaitersForHandle')
  const listener = vi.fn()
  const unsubscribe = runtime.onMobileSessionTabsChanged(listener)
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  const result = await cleanup.remove(() => {}, signal)
  expect(await cleanup.remove(() => {}, signal)).toEqual(result)
  expect(state.models.has(sourceId)).toBe(false)
  expect(state.tabs.has('source')).toBe(false)
  expect(state.tabs.has('other')).toBe(true)
  expect([...state.leaves.values()].some((leaf) => leaf.ptyId === sourceId)).toBe(false)
  expect(state.handles.has(handle)).toBe(false)
  expect(state.byPty.has(sourceId)).toBe(false)
  expect(runtime.inspect().indexed.has(sourceId)).toBe(false)
  expect(state.synthetic.has(handle)).toBe(false)
  expect(state.ptys.has(sourceId)).toBe(false)
  expect(source).toEqual(sourceBefore)
  expect(runtime.getPtyOutputSequence(sourceId)).toBe(0)
  expect(state.models.get(otherId)).toBe(otherModel)
  expect(state.mobile.get('folder:source')?.tabs).toEqual([])
  expect(state.mobile.get('folder:source')?.snapshotVersion).toBe(2)
  expect(state.mobile.get('folder:other')).toBe(otherSnapshot)
  expect(reject).toHaveBeenCalledExactlyOnceWith(handle, 'terminal_handle_stale')
  expect(exit).not.toHaveBeenCalled()
  expect(listener).toHaveBeenCalledOnce()
  expect(listener.mock.calls[0][0]).toMatchObject({
    worktree: 'folder:source',
    snapshotVersion: 2,
    tabs: []
  })
  unsubscribe()
})

it('cancels source observation timers once while retaining the other host observers', async () => {
  const { runtime, signal } = await fixture()
  vi.useFakeTimers()
  try {
    const sourceTimer = vi.fn()
    const otherTimer = vi.fn()
    runtime.seedObservationTimer(sourceId, sourceTimer)
    runtime.seedObservationTimer(otherId, otherTimer)
    const state = runtime.inspect()
    const sourceTracker = state.titles.get(sourceId)!.tracker
    const otherTracker = state.titles.get(otherId)
    const dispose = vi.spyOn(sourceTracker, 'dispose')
    const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
    fenceOutgoingPtyRegistrations(runtime, [sourceId])
    await cleanup.remove(() => {}, signal)
    await cleanup.remove(() => {}, signal)
    expect(state.waitChecks.has(sourceId)).toBe(false)
    expect(state.titles.has(sourceId)).toBe(false)
    expect(state.titles.get(otherId)).toBe(otherTracker)
    expect(dispose).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(60_000)
    expect(sourceTimer).not.toHaveBeenCalled()
    expect(otherTimer).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('does not redispose a title tracker after authority loss following disposal', async () => {
  const { runtime, signal } = await fixture()
  const state = runtime.inspect()
  const tracker = state.titles.get(sourceId)!.tracker
  const original = tracker.dispose.bind(tracker)
  let lost = false
  const dispose = vi.spyOn(tracker, 'dispose').mockImplementation(() => {
    original()
    lost = true
  })
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  await expect(
    cleanup.remove(() => {
      if (lost) {
        throw new Error('observation authority lost')
      }
    }, signal)
  ).rejects.toThrow('observation authority lost')
  expect(state.titles.has(sourceId)).toBe(true)
  expect(state.ptys.has(sourceId)).toBe(true)
  await cleanup.remove(() => {}, signal)
  expect(dispose).toHaveBeenCalledOnce()
  expect(state.titles.has(sourceId)).toBe(false)
})

it('refuses an aliased source tracker before disposing any model', async () => {
  const { runtime, signal } = await fixture()
  const state = runtime.inspect()
  const dispose = vi.spyOn(state.models.get(sourceId)!.emulator, 'dispose')
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  state.titles.set(otherId, state.titles.get(sourceId)!)
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  await expect(cleanup.remove(() => {}, signal)).rejects.toThrow('observation_alias_conflict')
  expect(dispose).not.toHaveBeenCalled()
})

it('retains record-retirement progress after authority loss and refuses resurrected records', async () => {
  const { runtime, signal } = await fixture()
  const state = runtime.inspect()
  const source = state.ptys.get(sourceId)!
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  await expect(
    cleanup.remove(() => {
      if (!state.ptys.has(sourceId)) {
        throw new Error('authority lost after record retirement')
      }
    }, signal)
  ).rejects.toThrow('authority lost after record retirement')
  expect(state.ptys.has(sourceId)).toBe(false)
  await cleanup.remove(() => {}, signal)
  state.ptys.set(sourceId, source)
  await expect(cleanup.remove(() => {}, signal)).rejects.toThrow('source_catalog_changed')
  expect(state.ptys.get(sourceId)).toBe(source)
})

it('refuses a recreated output counter after record retirement', async () => {
  const { runtime, signal } = await fixture()
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  await cleanup.remove(() => {}, signal)
  runtime.driftSourceSequence()
  await expect(cleanup.remove(() => {}, signal)).rejects.toThrow('source_record_reappeared')
})

it('refuses graph drift during model settlement before disposal or graph removal', async () => {
  const { runtime, signal } = await fixture()
  const state = runtime.inspect()
  const model = state.models.get(sourceId)!
  const pending = Promise.withResolvers<void>()
  const settle = vi.spyOn(model.ownership, 'settle').mockReturnValue(pending.promise)
  const dispose = vi.spyOn(model.emulator, 'dispose')
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  const running = cleanup.remove(() => {}, signal)
  await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
  await expect(cleanup.remove(() => {}, signal)).rejects.toThrow('cleanup_busy')
  state.byLeaf.set('foreign-alias', state.byPty.get(sourceId)!)
  const refused = expect(running).rejects.toThrow('source_graph_changed')
  pending.resolve()
  await refused
  expect(dispose).not.toHaveBeenCalled()
  expect(state.models.get(sourceId)).toBe(model)
  expect(state.byPty.has(sourceId)).toBe(true)
})

it('retries after authority loss following disposal without disposing the model twice', async () => {
  const { runtime, signal } = await fixture()
  const state = runtime.inspect()
  const model = state.models.get(sourceId)!
  const originalDispose = model.emulator.dispose.bind(model.emulator)
  let lost = false
  const dispose = vi.spyOn(model.emulator, 'dispose').mockImplementation(() => {
    originalDispose()
    lost = true
  })
  const authority = () => {
    if (lost) {
      throw new Error('authority lost')
    }
  }
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  await expect(cleanup.remove(authority, signal)).rejects.toThrow('authority lost')
  expect(state.byPty.has(sourceId)).toBe(true)
  await cleanup.remove(() => {}, signal)
  expect(dispose).toHaveBeenCalledOnce()
  expect(state.models.has(sourceId)).toBe(false)
  expect(state.byPty.has(sourceId)).toBe(false)
})

it('refuses source output-sequence drift before disposing any model', async () => {
  const { runtime, signal } = await fixture()
  const model = runtime.inspect().models.get(sourceId)!
  const dispose = vi.spyOn(model.emulator, 'dispose')
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  runtime.driftSourceSequence()
  await expect(cleanup.remove(() => {}, signal)).rejects.toThrow('source_output_changed')
  expect(dispose).not.toHaveBeenCalled()
  expect(runtime.inspect().models.get(sourceId)).toBe(model)
})

it('refuses tab replacement before disposing source models', async () => {
  const { runtime, signal } = await fixture()
  const state = runtime.inspect()
  const dispose = vi.spyOn(state.models.get(sourceId)!.emulator, 'dispose')
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  const replacement = { ...state.tabs.get('source')! }
  state.tabs.set('source', replacement)
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  await expect(cleanup.remove(() => {}, signal)).rejects.toThrow('source_tab_changed')
  expect(dispose).not.toHaveBeenCalled()
  expect(state.tabs.get('source')).toBe(replacement)
})

it('refuses mobile snapshot drift before disposing source models', async () => {
  const { runtime, signal } = await fixture()
  const state = runtime.inspect()
  const dispose = vi.spyOn(state.models.get(sourceId)!.emulator, 'dispose')
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  state.mobile.get('folder:source')!.snapshotVersion++
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  await expect(cleanup.remove(() => {}, signal)).rejects.toThrow('source_mobile_snapshot_changed')
  expect(dispose).not.toHaveBeenCalled()
  expect(state.byPty.has(sourceId)).toBe(true)
})

it('retries a failed snapshot notification without restamping or redisposing source state', async () => {
  const { runtime, signal } = await fixture()
  const state = runtime.inspect()
  const dispose = vi.spyOn(state.models.get(sourceId)!.emulator, 'dispose')
  const listener = vi.fn().mockImplementationOnce(() => {
    throw new Error('consumer unavailable')
  })
  const unsubscribe = runtime.onMobileSessionTabsChanged(listener)
  const broadNotify = vi.spyOn(runtime, 'notifyMobileSessionTabsChanged')
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  try {
    await expect(cleanup.remove(() => {}, signal)).rejects.toThrow('consumer unavailable')
    expect(state.ptys.has(sourceId)).toBe(true)
    expect(runtime.getPtyOutputSequence(sourceId)).toBeGreaterThan(0)
    const saved = state.mobile.get('folder:source')
    await cleanup.remove(() => {}, signal)
    await cleanup.remove(() => {}, signal)
    expect(dispose).toHaveBeenCalledOnce()
    expect(state.mobile.get('folder:source')).toBe(saved)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls.map(([snapshot]) => snapshot.snapshotVersion)).toEqual([2, 2])
    expect(broadNotify).not.toHaveBeenCalled()
  } finally {
    unsubscribe()
  }
})

it('cancels a pre-cleanup coalesced snapshot notification', async () => {
  const { runtime, signal } = await fixture()
  const listener = vi.fn()
  const unsubscribe = runtime.onMobileSessionTabsChanged(listener)
  const cleanup = runtime.prepareOutgoingSshPtyGraphAndModelCleanup('source')
  fenceOutgoingPtyRegistrations(runtime, [sourceId])
  vi.useFakeTimers()
  try {
    runtime.queueMobile('folder:source')
    await cleanup.remove(() => {}, signal)
    await vi.advanceTimersByTimeAsync(1000)
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0]).toMatchObject({ snapshotVersion: 2, tabs: [] })
  } finally {
    unsubscribe()
    vi.useRealTimers()
  }
})
