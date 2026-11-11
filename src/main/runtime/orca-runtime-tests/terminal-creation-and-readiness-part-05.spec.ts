import { describe, expect, it, vi } from 'vitest'
import { registerLivePty } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import 'node:path'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import 'node:fs/promises'
import 'node:os'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixtures.spec'
import { spawnedPtyEnv } from '../terminal/launch/spawned-pty-env-fixtures'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { collectLeafIds } from '../../../shared/workspace-layout/terminal-pane-layout-tree'

describe('OrcaRuntimeService', () => {
  it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'returns the exact pre-minted leaf for concurrent renderer-backed splits, each started by main',
    async () => {
      const tabId = 'tab-concurrent-splits'
      const sourceLeafId = HEADLESS_LEAF_ID
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
        makeWorkspaceSessionWithHeadlessTerminal({
          tabsByWorktree: {
            [TEST_WORKTREE_ID]: [
              {
                id: tabId,
                ptyId: 'pty-source',
                worktreeId: TEST_WORKTREE_ID,
                title: 'shell',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          },
          terminalLayoutsByTabId: {
            [tabId]: makeHeadlessTerminalLayout({ [sourceLeafId]: 'pty-source' })
          }
        })
      )
      const splitTerminal = vi.fn()
      const spawn = vi.fn(async (args: { leafId?: string }) => ({ id: `pty-${args.leafId}` }))
      const runtime = new OrcaRuntimeService(runtimeStore)
      runtime.setNotifier({ splitTerminal } as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'shell',
            activeLeafId: sourceLeafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            leafId: sourceLeafId,
            paneRuntimeId: 1,
            ptyId: 'pty-source',
            paneTitle: null
          }
        ]
      })
      registerLivePty(runtime, 'pty-source', TEST_WORKTREE_ID, null, {
        tabId,
        leafId: sourceLeafId
      })
      const sourceHandle = runtime.getTerminalHandleForPaneKey(makePaneKey(tabId, sourceLeafId))
      expect(sourceHandle).not.toBeNull()

      const [horizontal, vertical] = await Promise.all([
        runtime.splitTerminal(sourceHandle!, { direction: 'horizontal' }),
        runtime.splitTerminal(sourceHandle!, { direction: 'vertical' })
      ])

      expect(splitTerminal).not.toHaveBeenCalled()
      expect(horizontal.leafId).not.toBe(vertical.leafId)
      const leafIds = collectLeafIds(getSession().terminalLayoutsByTabId[tabId]?.root)
      expect(leafIds).toEqual(
        expect.arrayContaining([sourceLeafId, horizontal.leafId, vertical.leafId])
      )
      for (const split of [horizontal, vertical]) {
        expect(split.tabId).toBe(tabId)
        const leafId = split.leafId ?? ''
        const call = spawn.mock.calls.find(([args]) => args.leafId === leafId)
        expect(spawnedPtyEnv(call?.[0]).ORCA_PANE_KEY).toBe(makePaneKey(tabId, leafId))
      }
      expect(spawn).toHaveBeenCalledTimes(2)
    }
  )

  it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'returns the exact pre-minted leaf for concurrent renderer-backed splits',
    async () => {
      const tabId = 'tab-concurrent-splits'
      const sourceLeafId = '11111111-1111-4111-8111-111111111111'
      const splitTerminal = vi.fn()
      const runtime = new OrcaRuntimeService(store)
      runtime.setNotifier({ splitTerminal } as never)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'shell',
            activeLeafId: sourceLeafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            leafId: sourceLeafId,
            paneRuntimeId: 1,
            ptyId: 'pty-source',
            paneTitle: null
          }
        ]
      })
      const sourceHandle = runtime.getTerminalHandleForPaneKey(makePaneKey(tabId, sourceLeafId))
      expect(sourceHandle).not.toBeNull()

      const horizontal = runtime.splitTerminal(sourceHandle!, { direction: 'horizontal' })
      const vertical = runtime.splitTerminal(sourceHandle!, { direction: 'vertical' })
      await vi.waitFor(() => expect(splitTerminal).toHaveBeenCalledTimes(2))
      const horizontalLeafId = splitTerminal.mock.calls.find(
        (call) => call[2]?.direction === 'horizontal'
      )?.[2]?.newLeafId
      const verticalLeafId = splitTerminal.mock.calls.find(
        (call) => call[2]?.direction === 'vertical'
      )?.[2]?.newLeafId
      expect(horizontalLeafId).toEqual(expect.any(String))
      expect(verticalLeafId).toEqual(expect.any(String))
      expect(horizontalLeafId).not.toBe(verticalLeafId)

      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'shell',
            activeLeafId: verticalLeafId,
            layout: null
          }
        ],
        // Reverse publication order so a first-new-leaf heuristic would swap the receipts.
        leaves: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            leafId: verticalLeafId!,
            paneRuntimeId: 3,
            ptyId: 'pty-vertical',
            paneTitle: null
          },
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            leafId: horizontalLeafId!,
            paneRuntimeId: 2,
            ptyId: 'pty-horizontal',
            paneTitle: null
          },
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            leafId: sourceLeafId,
            paneRuntimeId: 1,
            ptyId: 'pty-source',
            paneTitle: null
          }
        ]
      })

      await expect(horizontal).resolves.toMatchObject({ leafId: horizontalLeafId })
      await expect(vertical).resolves.toMatchObject({ leafId: verticalLeafId })
    }
  )

  it('keeps a persisted split when mounted renderer adoption rejects', async () => {
    const tabId = 'persisted-mounted-tab'
    const ptyId = 'persisted-mounted-pty'
    const splitPtyId = 'persisted-mounted-split-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: tabId,
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
        }
      })
    )
    const revealTerminalSession = vi.fn().mockRejectedValue(new Error('renderer rejected'))
    const kill = vi.fn(() => true)
    let resolveSpawn!: (result: { id: string }) => void
    const spawn = vi.fn(
      (_args: unknown) =>
        new Promise<{ id: string }>((resolve) => {
          resolveSpawn = resolve
        })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({ revealTerminalSession } as never)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'live-source-incarnation'
    })
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get(ptyId))
    const split = runtime.splitTerminal(handle, { direction: 'horizontal' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const splitSpawn = spawn.mock.calls[0]?.[0] as
      | { expectedSourceBinding?: { incarnationId?: string } }
      | undefined
    // An unsaved incarnation cannot satisfy the store's persisted-binding fence.
    expect(splitSpawn?.expectedSourceBinding).not.toHaveProperty('incarnationId')

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Persisted terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: { type: 'leaf', leafId: HEADLESS_LEAF_ID }
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })
    resolveSpawn({ id: splitPtyId })

    await expect(split).resolves.toMatchObject({
      tabId,
      handle: expect.stringMatching(/^term_/)
    })

    expect(revealTerminalSession).toHaveBeenCalledOnce()
    expect(kill).not.toHaveBeenCalled()
    expect(getSession().terminalLayoutsByTabId[tabId]?.root).toMatchObject({
      type: 'split',
      direction: 'horizontal'
    })
  })

  it('rejects a projected split retired during spawn before publishing the new pane', async () => {
    let resolveSplitSpawn!: (result: { id: string }) => void
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'projected-source-pty' })
      .mockImplementationOnce(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveSplitSpawn = resolve
          })
      )
    const kill = vi.fn(() => true)
    const { runtimeStore, setSession } = makeRuntimeStoreWithWorkspaceSession(
      getDefaultWorkspaceSession()
    )
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const split = runtime.splitTerminal(handle, { direction: 'vertical' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))

    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    setSession(getDefaultWorkspaceSession())
    resolveSplitSpawn({ id: 'retired-projected-split-pty' })

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(kill).toHaveBeenCalledWith('retired-projected-split-pty')
    expect(runtime['mobileSessionTabsByWorktree'].has(TEST_WORKTREE_ID)).toBe(false)
  })
})
