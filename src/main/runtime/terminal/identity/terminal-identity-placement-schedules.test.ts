import '../../orca-runtime-test-lifecycle.spec'
import { expect, it, vi } from 'vitest'
import {
  identityFixture,
  watchIdentityFixture,
  LEAF,
  PANE
} from '../query/terminal-identity.test-fixture'
import {
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH
} from '../../orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { DurableProfileStateMutation } from '../../../persistence/loading-store/store-runtime-state'
import { forgetPtySurface } from '../../pty-recorded-surface-topology'

function sessions() {
  return makeRuntimeStoreWithWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
  })
}

function controller() {
  return {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [
      {
        id: 'pty-restored',
        incarnationId: 'original',
        terminalHandle: 'term_restored',
        title: 'bash',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }
    ]
  }
}

function setup() {
  const harness = sessions()
  const f = identityFixture(undefined, harness.runtimeStore)
  f.runtime.setPtyController(controller())
  return { f, harness }
}

it('discovers the actual restored placement only after layout apply and re-reads the current same-ID record', async () => {
  const results: unknown[] = []
  for (const replacement of [false, true]) {
    for (const captured of [false, true]) {
      const { f, harness } = setup()
      const entered = deferred<void>()
      const release = deferred<void>()
      const apply = harness.runtimeStore.applyLayoutCommand.getMockImplementation()
      if (!apply) {
        throw new Error('Expected the existing production layout reducer adapter')
      }
      const held = vi
        .spyOn(harness.runtimeStore, 'applyLayoutCommand')
        .mockImplementation(async (...args) => {
          entered.resolve()
          await release.promise
          return apply(...args)
        })
      const watched = watchIdentityFixture(f, captured)
      try {
        expect(watched.pane(PANE)).toBeNull()
        const placing = f.runtime.placeUnshownLiveTerminals()
        await Promise.race([
          entered.promise,
          placing.then(() => {
            throw new Error('Placement finished before apply')
          })
        ])
        const old = f.owner.ptysById.get('pty-restored')!
        const command = held.mock.calls[0]![0]
        if (command.type !== 'createTerminalTab') {
          throw new Error('Expected production restore create command')
        }
        const pane = `${command.tabId}:${command.leafId}`
        expect(watched.pane(pane)).toBeNull()
        const captures = watched.acquisition.mock.calls.length
        let current = old
        if (replacement) {
          f.owner.source.removePty('pty-restored')
          current = f.owner.recordPtyWorktree('pty-restored', TEST_WORKTREE_ID, {
            incarnationId: 'successor'
          })
          expect(watched.pane(pane)).toBeNull()
        }
        release.resolve()
        await expect(placing).resolves.toEqual({ placed: ['pty-restored'], declined: [] })
        expect(watched.pane(pane)).toBe(current)
        expect(watched.acquisition.mock.calls.length).toBeGreaterThan(captures)
        if (replacement) {
          expect(old.paneKey).toBeNull()
        }
        const context = watched.context()
        expect(f.runtime.getTerminalHandleForPaneKey(pane, context)).toBe('term_restored')
        expect(f.owner.handles.get('term_restored')?.issuedForPaneKey).toBeUndefined()
        expect(f.owner.handleByPtyId.get('pty-restored')).toBe('term_restored')
        results.push({
          state: f.state(),
          currentClaim: current.paneKey === pane,
          detachedClaim: old.paneKey === pane,
          standing: current.surfaceRecordedAtGraphSequence
        })
      } finally {
        release.resolve()
        watched.close()
      }
    }
    expect(results.at(-1)).toEqual(results.at(-2))
  }
})

it('keeps orphan commit, retained-record, replay and failed-flush effects equivalent across default and captured reads', async () => {
  const results: unknown[] = []
  for (const [mode, replacement, failure] of [
    ['durable', false, false],
    ['flush', false, false],
    ['durable', true, false],
    ['flush', true, false],
    ['flush', false, true]
  ] as const) {
    for (const captured of [false, true]) {
      const harness = sessions()
      const entered = deferred<void>()
      const release = deferred<void>()
      const durable = harness.runtimeStore.runDurableMutation.bind(harness.runtimeStore)
      const runtimeStore = {
        ...harness.runtimeStore,
        runDurableMutation:
          mode === 'durable'
            ? async <T>(mutate: () => DurableProfileStateMutation<T>): Promise<T> => {
                const result = await durable(mutate)
                entered.resolve()
                await release.promise
                return result
              }
            : undefined,
        flushPendingOrThrowAsync: async () => {
          entered.resolve()
          await release.promise
          if (failure) {
            throw new Error('disk_full')
          }
        }
      }
      const f = identityFixture(undefined, runtimeStore)
      f.runtime.setPtyController(controller())
      const before = await f.runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
      const pty = f.owner.ptysById.get('pty-restored')!
      const request = {
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: before.topologyRevisions?.[TEST_WORKTREE_ID] ?? 0,
        claims: [
          {
            terminal: 'term_restored',
            ptyId: 'pty-restored',
            incarnationId: 'original',
            tabId: 'tab-original',
            leafId: LEAF
          }
        ]
      }
      const watched = watchIdentityFixture(f, captured)
      try {
        expect(watched.pane(PANE)).toBeNull()
        const adopting = f.runtime.adoptTerminalOrphans(request)
        await Promise.race([
          entered.promise,
          adopting.then(() => {
            throw new Error('Adoption finished before persistence wait')
          })
        ])
        expect(
          harness.getSession().terminalLayoutsByTabId['tab-original']?.ptyIdsByLeafId?.[LEAF]
        ).toBe('pty-restored')
        expect(watched.pane(PANE)).toBeNull()
        const captures = watched.acquisition.mock.calls.length
        const successor = replacement
          ? (() => {
              f.owner.source.removePty('pty-restored')
              return f.owner.recordPtyWorktree('pty-restored', TEST_WORKTREE_ID, {
                incarnationId: 'successor'
              })
            })()
          : null
        if (successor) {
          expect(watched.pane(PANE)).toBeNull()
        }
        release.resolve()
        if (failure) {
          await expect(adopting).rejects.toThrow('disk_full')
          expect(harness.getSession().terminalLayoutsByTabId['tab-original']).toBeUndefined()
          expect(pty.paneKey).toBeNull()
          expect(watched.pane(PANE)).toBeNull()
          results.push({ state: f.state(), pane: pty.paneKey, failed: true })
          continue
        }
        await expect(adopting).resolves.toMatchObject({ adopted: true })
        if (successor) {
          expect(pty.paneKey).toBe(PANE)
          expect(successor.paneKey).toBeNull()
          expect(f.owner.ptysById.get('pty-restored')).toBe(successor)
          expect(watched.pane(PANE)).toBeNull()
          expect(watched.acquisition.mock.calls.length).toBeGreaterThan(captures)
          results.push({ state: f.state(), detached: pty.paneKey, current: successor.paneKey })
          continue
        }
        expect(watched.pane(PANE)).toBe(pty)
        expect(watched.acquisition.mock.calls.length).toBeGreaterThan(captures)
        expect(f.runtime.getTerminalHandleForPaneKey(PANE, watched.context())).toBe('term_restored')
        const standing = pty.surfaceRecordedAtGraphSequence
        await expect(f.runtime.adoptTerminalOrphans(request)).resolves.toMatchObject({
          adopted: false
        })
        expect(pty.surfaceRecordedAtGraphSequence).toBe(standing)
        forgetPtySurface(f.owner.source, pty)
        expect(watched.pane(PANE)).toBeNull()
        await expect(f.runtime.adoptTerminalOrphans(request)).resolves.toMatchObject({
          adopted: false
        })
        expect(watched.pane(PANE)).toBe(pty)
        expect(pty.surfaceRecordedAtGraphSequence).toBe(0)
        const settled = watched.acquisition.mock.calls.length
        await expect(f.runtime.adoptTerminalOrphans(request)).resolves.toMatchObject({
          adopted: false
        })
        watched.context()
        expect(watched.acquisition).toHaveBeenCalledTimes(settled)
        results.push({
          state: f.state(),
          pane: pty.paneKey,
          standing: pty.surfaceRecordedAtGraphSequence
        })
      } finally {
        release.resolve()
        watched.close()
      }
    }
    expect(results.at(-1)).toEqual(results.at(-2))
  }
})
