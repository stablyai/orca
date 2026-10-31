import { afterEach, expect, it, vi } from 'vitest'
import {
  identityFixture,
  identityGraph,
  watchIdentityFixture,
  LEAF,
  PANE
} from '../query/terminal-identity.test-fixture'
import { TEST_WORKTREE_ID } from '../../orca-runtime-test-fixtures.spec'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'
import { RUNTIME_GRAPH_RELOAD_TIMEOUT_MS } from '../../runtime-graph-reload-lifecycle'

afterEach(() => vi.useRealTimers())

function exitWaiter(f: ReturnType<typeof identityFixture>, handle: string) {
  const reject = vi.fn()
  f.owner.terminalWaiters.add({
    handle,
    ptyId:
      f.owner.handles.get(handle)?.ptyId ??
      [...f.owner.handleByPtyId].find(([, value]) => value === handle)?.[0] ??
      '',
    condition: 'exit',
    resolve: vi.fn(),
    reject,
    timeout: null,
    cancelIdlePoll: null,
    abortCleanup: null
  })
  return reject
}

it('fences the old waiter at actual spawn before registration and routes successor output through canonical leaves in either read mode', async () => {
  const run = async (captured: boolean) => {
    const f = identityFixture()
    const writes: string[] = []
    f.runtime.setPtyController({
      write: (_id, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    f.runtime.registerPty('pty-same', TEST_WORKTREE_ID, null, {
      tabId: 'tab-original',
      leafId: LEAF,
      incarnationId: 'old',
      terminalHandle: 'term_old'
    })
    f.runtime.attachWindow(1)
    f.runtime.syncWindowGraph(1, identityGraph('pty-same'))
    const leaf = f.owner.getLeavesForPty('pty-same')[0]!
    const pty = f.owner.ptysById.get('pty-same')!
    const watched = watchIdentityFixture(f, captured)
    try {
      expect(watched.pane(PANE)).toBe(pty)
      const reject = exitWaiter(f, 'term_old')
      const effects: string[] = []
      reject.mockImplementation(() => effects.push('reject-old'))
      f.runtime.onPtySpawned('pty-same', 'new')
      effects.push('spawn-returned')
      expect(reject).toHaveBeenCalledOnce()
      expect(f.owner.terminalWaiters.forPty('pty-same')).toEqual([])
      expect(f.owner.getLivePtyForHandle('term_old', watched.context())).toBeNull()
      f.runtime.registerPreAllocatedHandleForPty('pty-same', 'term_old')
      f.runtime.registerPty('pty-same', TEST_WORKTREE_ID, null, {
        tabId: 'tab-original',
        leafId: LEAF,
        incarnationId: 'new',
        terminalHandle: 'term_new'
      })
      effects.push('registered')
      await expect(
        f.runtime.sendTerminal('term_old', { text: 'old input' }, { inputKind: 'driving' })
      ).rejects.toThrow('terminal_handle_stale')
      expect(writes).toEqual([])
      expect(f.runtime.getTerminalWorktreeIdForHandle('term_new', watched.context())).toBe(
        TEST_WORKTREE_ID
      )
      expect(f.runtime.getTerminalProcessIncarnation('term_new', watched.context())).toBe(
        'pty-same:new'
      )
      expect(f.owner.getLeavesForPty('pty-same')[0]).toBe(leaf)
      f.runtime.onPtyData('pty-same', 'successor output\r\n', 500)
      effects.push('output')
      expect(leaf.preview).toContain('successor output')
      expect(pty.preview).toContain('successor output')
      expect(f.owner.getLeavesForPty('pty-same')[0]).toBe(leaf)
      expect(reject).toHaveBeenCalledOnce()
      expect(effects).toEqual(['reject-old', 'spawn-returned', 'registered', 'output'])
      watched.context()
      const settled = watched.acquisition.mock.calls.length
      f.runtime.onPtyData('pty-same', 'ordinary output', 501)
      watched.context()
      expect(watched.acquisition).toHaveBeenCalledTimes(settled)
      return {
        state: f.state(),
        effects,
        preview: leaf.preview,
        oldWaiterCalls: reject.mock.calls.length
      }
    } finally {
      watched.close()
    }
  }
  expect(await run(true)).toEqual(await run(false))
})

it('uses actual graph close, promotion, cancellation and timeout without a browser publisher, retaining only proved control', async () => {
  vi.useFakeTimers()
  const run = async (captured: boolean) => {
    const f = identityFixture()
    const publication = identityGraph('pty-known')
    const unknownLeaf = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    publication.leaves.push({
      tabId: 'tab-original',
      worktreeId: TEST_WORKTREE_ID,
      leafId: unknownLeaf,
      paneRuntimeId: 2,
      ptyId: 'pty-unknown'
    })
    f.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    f.runtime.registerPty('pty-known', TEST_WORKTREE_ID, null, {
      tabId: 'tab-original',
      leafId: LEAF,
      incarnationId: 'known',
      terminalHandle: 'term_known'
    })
    f.runtime.attachWindow(1)
    f.runtime.syncWindowGraph(1, publication)
    const watched = watchIdentityFixture(f, captured)
    try {
      expect(watched.pane(PANE)?.ptyId).toBe('pty-known')
      const rejectedOnClose = exitWaiter(f, 'term_known')
      f.owner.markUnavailable(1)
      expect(f.runtime.shouldRelayTerminalBrowserOpens()).toBe(true)
      expect(f.owner.leaves.size).toBe(0)
      expect(f.owner.getLeavesForPty('pty-known')).toEqual([])
      expect(rejectedOnClose).toHaveBeenCalledOnce()
      expect(f.owner.handleByPtyId.get('pty-known')).toBe('term_known')
      expect(f.owner.getLivePtyForHandle('term_known', watched.context())?.pty.ptyId).toBe(
        'pty-known'
      )
      watched.context()
      const idle = watched.acquisition.mock.calls.length
      f.owner.markUnavailable(1)
      watched.context()
      expect(watched.acquisition).toHaveBeenCalledTimes(idle)
      f.runtime.attachWindow(2)
      f.runtime.syncWindowGraph(2, publication)
      const unknownHandle = f.owner.issueHandle(f.owner.leaves.get(`tab-original::${unknownLeaf}`)!)
      const rejectUnknown = exitWaiter(f, unknownHandle)
      const rejectKnown = exitWaiter(f, 'term_known')
      const fence = f.runtime.markRendererReloading(2)
      if (!fence) {
        throw new Error('Expected active renderer reload fence')
      }
      expect(rejectKnown).not.toHaveBeenCalled()
      // Reload drops an unproved alias; PTY-keyed waits survive until the process or graph ends.
      expect(rejectUnknown).not.toHaveBeenCalled()
      expect(f.owner.handles.has(unknownHandle)).toBe(false)
      expect(f.runtime.markRendererReloadCancelled(2, fence)).toBe(true)
      expect(f.owner.getLeavesForPty('pty-known')[0]?.ptyId).toBe('pty-known')
      expect(f.runtime.getTerminalWorktreeIdForHandle('term_known', watched.context())).toBe(
        TEST_WORKTREE_ID
      )
      const timeout = f.runtime.markRendererReloading(2)
      expect(timeout).not.toBeNull()
      await vi.advanceTimersByTimeAsync(RUNTIME_GRAPH_RELOAD_TIMEOUT_MS)
      expect(rejectKnown).toHaveBeenCalledOnce()
      expect(rejectUnknown).toHaveBeenCalledOnce()
      expect(() => f.runtime.assertGraphReady()).toThrow('runtime_unavailable')
      expect(f.owner.leaves.size).toBe(0)
      expect(f.owner.getLeavesForPty('pty-known')).toEqual([])
      expect(f.owner.handles.size).toBe(0)
      f.runtime.syncWindowGraph(2, publication)
      expect(() => f.runtime.assertGraphReady()).not.toThrow()
      expect(watched.pane(PANE)).toBe(f.owner.getPtyRecordForPaneKey(PANE))
      expect(f.owner.getLeavesForPty('pty-known')[0]?.ptyId).toBe('pty-known')
      expect(rejectKnown).toHaveBeenCalledOnce()
      expect(f.runtime.markRendererReloadCancelled(2, fence)).toBe(false)
      const state = f.state()
      return {
        ...state,
        rejected: state.rejected.map(([handle, reason]) => [
          handle === unknownHandle ? '<unknown>' : handle,
          reason
        ]),
        waiterCalls: [
          rejectedOnClose.mock.calls.length,
          rejectKnown.mock.calls.length,
          rejectUnknown.mock.calls.length
        ]
      }
    } finally {
      watched.close()
    }
  }
  expect(await run(true)).toEqual(await run(false))
})

it('retires Crew raw capture for actual execution-context distro learn and output-generation reset while no-ops stay idle', () => {
  const f = identityFixture()
  const pty = f.owner.recordPtyWorktree('pty-distro', TEST_WORKTREE_ID)
  const watched = watchIdentityFixture(f)
  try {
    expect(watched.pane(PANE)).toBeNull()
    const initial = watched.acquisition.mock.calls.length
    expect(f.runtime.preparePtyExecutionContext('pty-distro', 'Ubuntu')).toBe(true)
    watched.context()
    expect(pty.wslDistro).toBe('Ubuntu')
    expect(watched.acquisition).toHaveBeenCalledTimes(initial + 1)
    const learned = watched.acquisition.mock.calls.length
    expect(
      f.runtime.preparePtyExecutionContext('pty-distro', 'Debian', { preserveExisting: true })
    ).toBe(false)
    expect(f.runtime.preparePtyExecutionContext('pty-distro', 'Ubuntu')).toBe(false)
    watched.context()
    expect(watched.acquisition).toHaveBeenCalledTimes(learned)
    f.runtime.synchronizePtyOutputSequenceFromProvider('pty-distro', {
      value: 0,
      generation: 'reset'
    })
    watched.context()
    expect(pty.wslDistro).toBeNull()
    expect(watched.acquisition).toHaveBeenCalledTimes(learned + 1)
    const reset = watched.acquisition.mock.calls.length
    f.runtime.synchronizePtyOutputSequenceFromProvider('pty-distro', {
      value: 0,
      generation: 'continued'
    })
    f.runtime.preparePtyExecutionContext('pty-distro', null)
    watched.context()
    expect(watched.acquisition).toHaveBeenCalledTimes(reset)
  } finally {
    watched.close()
  }
})

it('retains pane-issued process identity across reload with exact first-match and SSH precedence in either context', () => {
  for (const captured of [false, true]) {
    const f = identityFixture()
    f.runtime.registerPty('retained-process', TEST_WORKTREE_ID, null, {
      tabId: 'tab-original',
      leafId: LEAF,
      incarnationId: 'original'
    })
    f.runtime.attachWindow(1)
    f.runtime.syncWindowGraph(1, identityGraph('retained-process'))
    const handle = f.runtime.getTerminalHandleForPaneKey(PANE)!
    expect(handle).toMatch(/^term_/)
    expect(f.owner.handleByPtyId.has('retained-process')).toBe(false)
    expect(f.owner.handleByPtyIncarnation.get('retained-process')?.handle).toBe(handle)
    expect(f.runtime.getTerminalProcessIncarnation(handle)).toBe('retained-process:original')
    const fence = f.runtime.markRendererReloading(1)
    expect(fence).not.toBeNull()
    expect(f.owner.handles.has(handle)).toBe(false)
    expect(f.owner.handleByLeafKey.size).toBe(0)
    const attachment = f.runtime.registerOrchestrationCompatibilitySshAttachment(
      'remote',
      'connection',
      {
        handle,
        paneKey: PANE,
        processIncarnation: 'ssh-process'
      }
    )
    const read = () =>
      f.runtime.getTerminalProcessIncarnation(
        handle,
        captured ? f.runtime.createTerminalIdentityReadContext() : undefined
      )
    try {
      expect(read()).toBe('retained-process:original')
      const pty = f.owner.ptysById.get('retained-process')!
      f.owner.source.setPtyConnected(pty, false)
      expect(read()).toBe('retained-process:original')
      f.owner.source.setPtyIncarnationId(pty, 'replacement')
      expect(read()).toBe('ssh-process')
      f.owner.source.setIncarnation('retained-process', {
        handle,
        incarnationId: null,
        leafKey: 'first'
      })
      f.owner.recordPtyWorktree('later-valid', TEST_WORKTREE_ID, { incarnationId: 'later' })
      f.owner.source.setIncarnation('later-valid', {
        handle,
        incarnationId: 'later',
        leafKey: 'later'
      })
      expect(read()).toBe('ssh-process')
      f.owner.source.setIncarnation('retained-process', {
        handle,
        incarnationId: 'stale',
        leafKey: 'first'
      })
      expect(read()).toBe('ssh-process')
      f.owner.source.removeIncarnation('retained-process')
      expect(read()).toBe('later-valid:later')
      f.owner.source.removeIncarnation('later-valid')
      expect(read()).toBe('ssh-process')
      f.runtime.releaseOrchestrationCompatibilitySshAttachment(attachment.attachmentId)
      expect(read()).toBeNull()
    } finally {
      f.runtime.releaseOrchestrationCompatibilitySshAttachment(attachment.attachmentId)
      if (fence) {
        f.runtime.markRendererReloadCancelled(1, fence)
      }
    }
  }
})

it('observes actual retained issuance, removal and reinsertion in already-open shared-raw readers', () => {
  const f = identityFixture()
  f.runtime.registerPty('shared-retained', TEST_WORKTREE_ID, null, {
    tabId: 'tab-original',
    leafId: LEAF,
    incarnationId: 'shared-process'
  })
  f.runtime.attachWindow(1)
  f.runtime.syncWindowGraph(1, identityGraph('shared-retained'))
  const raw = f.runtime.createTerminalIdentityRawInputs()
  const contexts = [
    undefined,
    f.runtime.createTerminalIdentityReadContext(raw),
    f.runtime.createTerminalIdentityReadContext(raw)
  ]
  const handle = f.runtime.getTerminalHandleForPaneKey(PANE, contexts[1])!
  const retained = f.owner.handleByPtyIncarnation.get('shared-retained')!
  expect(retained.handle).toBe(handle)
  const fence = f.runtime.markRendererReloading(1)
  expect(fence).not.toBeNull()
  const read = () =>
    contexts.map((context) => f.runtime.getTerminalProcessIncarnation(handle, context))
  try {
    expect(read()).toEqual(contexts.map(() => 'shared-retained:shared-process'))
    f.owner.source.removeIncarnation('shared-retained')
    expect(read()).toEqual(contexts.map(() => null))
    f.owner.source.setIncarnation('shared-retained', retained)
    expect(read()).toEqual(contexts.map(() => 'shared-retained:shared-process'))
    f.owner.source.clearIncarnations()
    expect(read()).toEqual(contexts.map(() => null))
  } finally {
    if (fence) {
      f.runtime.markRendererReloadCancelled(1, fence)
    }
  }
})
