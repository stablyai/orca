import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  store
} from '../orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../../shared/constants'

type RuntimeStoreWithOptionalWorkspaceSession = typeof store & {
  getWorkspaceSession?: () => ReturnType<typeof getDefaultWorkspaceSession>
}

// #21341: a paired client that wakes replays terminal.create with the original tabId/leafId of every
// mirrored pane whose host PTY is gone. The host used to adopt that hint on id format alone and
// spawn a fresh shell under a tab its own user had already closed.
function createRuntimeWithSpawn(): {
  runtime: InstanceType<typeof OrcaRuntimeService>
  spawn: ReturnType<typeof vi.fn>
} {
  let ptyCount = 0
  const spawn = vi.fn(async () => ({ id: `pty-retired-hint-${(ptyCount += 1)}` }))
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

/** A host whose store can read a workspace session but not write one, so a retirement is recorded
 *  while the surface it names stays published. */
function createRuntimeWithUnacceptedRetirement(): {
  runtime: InstanceType<typeof OrcaRuntimeService>
  spawn: ReturnType<typeof vi.fn>
  runtimeStore: RuntimeStoreWithOptionalWorkspaceSession
} {
  let ptyCount = 0
  const spawn = vi.fn(async () => ({ id: `pty-unaccepted-retirement-${(ptyCount += 1)}` }))
  const runtimeStore: RuntimeStoreWithOptionalWorkspaceSession = {
    ...store,
    getWorkspaceSession: () => getDefaultWorkspaceSession()
  }
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn, runtimeStore }
}

describe('terminal.create refuses a pane identity the host already retired', () => {
  it('rejects the hinted id without spawning once the host retired that pane', async () => {
    const { runtime, spawn } = createRuntimeWithSpawn()
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'woken-client-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    // The host user closing the tab kills the PTY through pty:kill, which marks the stop before
    // the exit lands; that pairing is what onPtyExit reads back as an operator close.
    runtime.markPtyStopRequested(created.ptyId!)
    runtime.onPtyExit(created.ptyId!, 0, undefined, { hostExitConfirmed: true })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'woken-client-tab',
        leafId: HEADLESS_LEAF_ID
      })
    ).rejects.toThrow('tab_not_found')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  // The reported topology: the host user made the tab in the desktop renderer and a paired client
  // only mirrors it, so the pane reaches the host through the graph sync rather than through create.
  it('rejects the hinted id for a renderer-created pane the host retired', async () => {
    const { runtime, spawn } = createRuntimeWithSpawn()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'desktop-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'desktop-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'pty-desktop'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-retired-pane-hint',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `desktop-tab::${HEADLESS_LEAF_ID}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `desktop-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'desktop-tab',
              leafId: HEADLESS_LEAF_ID,
              ptyId: 'pty-desktop',
              title: 'Terminal',
              isActive: true
            }
          ]
        }
      ]
    })
    // Mirroring the pane is what makes the host mint the handle its retirement proof is keyed by.
    await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    runtime.markPtyStopRequested('pty-desktop')
    runtime.onPtyExit('pty-desktop', 0, undefined, { hostExitConfirmed: true })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'desktop-tab',
        leafId: HEADLESS_LEAF_ID
      })
    ).rejects.toThrow('tab_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })

  // A shell the user exited by hand retires the surface the same way, and on a headless host
  // nothing republishes it — so only a deliberate close may refuse the pane's restart in place.
  it('still adopts the hinted id after a natural shell exit', async () => {
    const { runtime, spawn } = createRuntimeWithSpawn()
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'exited-shell-tab',
      leafId: HEADLESS_LEAF_ID
    })

    // No stop was requested, so onPtyExit cannot read this back as an operator close.
    runtime.onPtyExit(created.ptyId!, 0, undefined, { hostExitConfirmed: true })

    const restarted = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'exited-shell-tab',
      leafId: HEADLESS_LEAF_ID
    })

    expect(restarted.tabId).toBe('exited-shell-tab')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  // Worktree sleep and pane hibernation also stop the PTY on purpose, but the pane is meant to come
  // back and the wake replays exactly these ids — refusing it would delete the terminal.
  it('still adopts the hinted id after a reversible stop', async () => {
    const { runtime, spawn } = createRuntimeWithSpawn()
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'slept-pane-tab',
      leafId: HEADLESS_LEAF_ID
    })

    runtime.markPtyStopRequested(created.ptyId!, { reversible: true })
    runtime.onPtyExit(created.ptyId!, 0, undefined, { hostExitConfirmed: true })

    const woken = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'slept-pane-tab',
      leafId: HEADLESS_LEAF_ID
    })

    expect(woken.tabId).toBe('slept-pane-tab')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  // The caller that gives the pane up for good is the one to believe, whatever asked first.
  it('rejects the hinted id when an irreversible stop follows a reversible one', async () => {
    const { runtime } = createRuntimeWithSpawn()
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'slept-then-closed-tab',
      leafId: HEADLESS_LEAF_ID
    })

    runtime.markPtyStopRequested(created.ptyId!, { reversible: true })
    runtime.markPtyStopRequested(created.ptyId!)
    runtime.onPtyExit(created.ptyId!, 0, undefined, { hostExitConfirmed: true })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'slept-then-closed-tab',
        leafId: HEADLESS_LEAF_ID
      })
    ).rejects.toThrow('tab_not_found')
  })

  // The gate adopts a retired pane the host still publishes, and the spawn after it can fail. A
  // retirement cleared at the gate would then be gone with nothing bound to the pane, and the next
  // replay of the same hint adopted. Persistence that cannot accept the retirement is what keeps
  // the surface published here.
  it('keeps refusing the hint when the create fails before a PTY binds to the pane', async () => {
    const { runtime, spawn, runtimeStore } = createRuntimeWithUnacceptedRetirement()
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'unbound-spawn-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.markPtyStopRequested(created.ptyId!)
    runtime.onPtyExit(created.ptyId!, 0, undefined, { hostExitConfirmed: true })

    spawn.mockRejectedValueOnce(new Error('spawn_failed'))
    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'unbound-spawn-tab',
        leafId: HEADLESS_LEAF_ID
      })
    ).rejects.toThrow('spawn_failed')

    // Dropping the session reader lets the retirement through, so the host stops publishing the pane.
    delete runtimeStore.getWorkspaceSession
    runtime.onPtyExit(created.ptyId!, 0, undefined, { hostExitConfirmed: true })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'unbound-spawn-tab',
        leafId: HEADLESS_LEAF_ID
      })
    ).rejects.toThrow('tab_not_found')
  })

  // The create's hint gate deliberately leaves the record alone: only a PTY that actually bound to
  // the pane proves it is live again, and the spawn between the two can still fail.
  it('forgets the retirement once a PTY binds to the pane again', async () => {
    const { runtime } = createRuntimeWithSpawn()
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'rebound-pane-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.markPtyStopRequested(created.ptyId!)
    runtime.onPtyExit(created.ptyId!, 0, undefined, { hostExitConfirmed: true })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'rebound-pane-tab',
        leafId: HEADLESS_LEAF_ID
      })
    ).rejects.toThrow('tab_not_found')

    runtime.registerPty('pty-rebound-pane', TEST_WORKTREE_ID, null, {
      tabId: 'rebound-pane-tab',
      leafId: HEADLESS_LEAF_ID
    })

    const adopted = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'rebound-pane-tab',
      leafId: HEADLESS_LEAF_ID
    })

    expect(adopted.tabId).toBe('rebound-pane-tab')
  })

  it('still adopts a hinted id the host never retired', async () => {
    const { runtime, spawn } = createRuntimeWithSpawn()

    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'live-host-tab',
      leafId: HEADLESS_LEAF_ID
    })

    expect(created.tabId).toBe('live-host-tab')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      tabId: 'live-host-tab',
      leafId: HEADLESS_LEAF_ID
    })
  })

  it('leaves an unhinted create untouched after a retirement in the same worktree', async () => {
    const { runtime, spawn } = createRuntimeWithSpawn()
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'retired-sibling-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.markPtyStopRequested(created.ptyId!)
    runtime.onPtyExit(created.ptyId!, 0, undefined, { hostExitConfirmed: true })

    const fresh = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`)

    expect(fresh.tabId).not.toBe('retired-sibling-tab')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('adopts a split leaf under a tab whose sibling pane was retired', async () => {
    const { runtime, spawn } = createRuntimeWithSpawn()
    const first = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'split-owner-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.markPtyStopRequested(first.ptyId!)
    runtime.onPtyExit(first.ptyId!, 0, undefined, { hostExitConfirmed: true })

    // The refusal is per paneKey, so a different leaf under the same tab id is not the retired pane.
    const sibling = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'split-owner-tab',
      leafId: HEADLESS_SECOND_LEAF_ID
    })

    expect(sibling.tabId).toBe('split-owner-tab')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      tabId: 'split-owner-tab',
      leafId: HEADLESS_SECOND_LEAF_ID
    })
  })
})
