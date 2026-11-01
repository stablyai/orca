import '../../orca-runtime-test-lifecycle.spec'
import { expect, it, vi } from 'vitest'
import {
  identityFixture,
  watchIdentityFixture,
  PANE
} from '../query/terminal-identity.test-fixture'
import {
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH
} from '../../orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'

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
  const watched = watchIdentityFixture(f, true)
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
    // A same-ID successor replaces the record while placement is still waiting on apply.
    f.owner.source.removePty('pty-restored')
    const current = f.owner.recordPtyWorktree('pty-restored', TEST_WORKTREE_ID, {
      incarnationId: 'successor'
    })
    expect(watched.pane(pane)).toBeNull()
    release.resolve()
    await expect(placing).resolves.toEqual({ placed: ['pty-restored'], declined: [] })
    expect(watched.pane(pane)).toBe(current)
    expect(watched.acquisition.mock.calls.length).toBeGreaterThan(captures)
    expect(old.paneKey).toBeNull()
    const context = watched.context()
    expect(f.runtime.getTerminalHandleForPaneKey(pane, context)).toBe('term_restored')
    expect(f.owner.handles.get('term_restored')?.issuedForPaneKey).toBeUndefined()
    expect(f.owner.handleByPtyId.get('pty-restored')).toBe('term_restored')
  } finally {
    release.resolve()
    watched.close()
  }
})
