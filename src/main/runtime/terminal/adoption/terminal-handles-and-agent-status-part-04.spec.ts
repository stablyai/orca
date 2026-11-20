import type { AdoptStablePaneArgs, AdoptStablePaneResult } from '../../../ipc/pty/ipc/spawn-types'
import { describe, expect, it, vi } from 'vitest'
import '../layout/bind-first-pane.test-fixture'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('preserves host metadata when terminal.create adopts a stable pane owner', async () => {
    const adoptStablePane = vi.fn(
      async (args: AdoptStablePaneArgs): Promise<AdoptStablePaneResult | null> => {
        await args.spawnFresh?.({ mustExist: false })
        return null
      }
    )
    const spawn = vi.fn(async (opts: { adoptedStablePane?: { owner: { handle?: string } } }) =>
      opts.adoptedStablePane
        ? {
            id: 'pty-stable-owner',
            isReattach: true,
            stablePaneOwner: {
              handle: opts.adoptedStablePane.owner.handle!,
              tabId: 'stable-owner-tab',
              leafId: HEADLESS_LEAF_ID
            }
          }
        : { id: 'pty-stable-owner' }
    )
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'in-process' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      adoptStablePane,
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const first = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'stable-owner-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Original owner',
      launchAgent: 'claude'
    })
    adoptStablePane.mockResolvedValueOnce({
      materialized: true,
      result: { id: 'pty-stable-owner', isReattach: true },
      owner: {
        handle: first.handle,
        tabId: 'stable-owner-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-stable-owner'
      }
    })

    const adopted = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'stable-owner-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Replacement intent',
      command: "claude 'replacement'",
      launchAgent: 'claude'
    })
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(adopted).toMatchObject({
      handle: first.handle,
      ptyId: 'pty-stable-owner',
      title: 'Original owner',
      isReattach: true
    })
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'stable-owner-tab',
        title: 'Original owner',
        launchAgent: 'claude'
      })
    ])
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('refuses before spawning when the client disconnects during pane adoption', async () => {
    const abort = new AbortController()
    const spawn = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      adoptStablePane: vi.fn(async (args: AdoptStablePaneArgs) => {
        abort.abort()
        await args.spawnFresh?.({ mustExist: false })
        return null
      }),
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'disconnected-during-adopt',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')

    expect(spawn).not.toHaveBeenCalled()
  })
})
