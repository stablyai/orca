import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from './orca-runtime-core'
import { countTerminalLayoutLeaves } from './headless-terminal-split-layout'

const WORKTREE_ID = 'repo-ratio::/workspace'
const TAB_ID = 'tab-ratio'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SOURCE_PTY = 'ratio-source'

afterEach(() => {
  setRuntimeDesktopSurface(null)
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve: (value: T) => resolve?.(value) }
}

function createHarness(sync: boolean | null = null, projected = false) {
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false } }
  const installWindow = (current = window) =>
    setRuntimeDesktopSurface({
      showNotification: () => false,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ratio authority reads only the mock window's identity and destruction predicates.
      findWindowById: () => current as never,
      onIpc: () => {},
      removeIpcListener: () => {}
    })
  installWindow()
  const repo: {
    id: string
    path: string
    displayName: string
    badgeColor: string
    addedAt: number
    connectionId?: string
  } = {
    id: 'repo-ratio',
    path: '/workspace',
    displayName: 'ratio',
    badgeColor: 'blue',
    addedAt: 1,
    connectionId: undefined
  }
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: SOURCE_PTY,
          worktreeId: WORKTREE_ID,
          title: 'Source',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: SOURCE_PTY }
      }
    }
  }
  if (projected) {
    session = getDefaultWorkspaceSession()
  }
  const store: RuntimeStore = {
    getRepos: () => [repo],
    getRepo: () => repo,
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
    removeWorktreeMeta: vi.fn(),
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getSettings: () => ({
      workspaceDir: '/workspace',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next) => {
      session = next
    },
    persistPtyBinding: async () => true
  }
  const runtime = new OrcaRuntimeService(store)
  const spawn = vi.fn(async () => ({ id: 'ratio-created' }))
  const hasPty = vi.fn<NonNullable<RuntimePtyController['hasPty']>>(() => sync)
  const probe = vi.fn<NonNullable<RuntimePtyController['probePtyLiveness']>>(async () => null)
  const controller: RuntimePtyController = {
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    hasPty,
    probePtyLiveness: probe
  }
  runtime.setPtyController(controller)
  const reveal = vi.fn(async () => ({ tabId: TAB_ID }))
  runtime.setNotifier({
    worktreesChanged: () => {},
    reposChanged: () => {},
    activateWorktree: () => {},
    createTerminal: () => {},
    revealTerminalSession: reveal,
    splitTerminal: () => {},
    renameTerminal: () => {},
    focusTerminal: () => {},
    closeTerminal: () => {},
    sleepWorktree: () => {},
    terminalFitOverrideChanged: () => {},
    terminalDriverChanged: () => {}
  })
  const scope = {
    id: WORKTREE_ID,
    path: '/workspace',
    connectionId: null,
    repo,
    folderWorkspace: null
  }
  const launch = vi.fn(async () => ({
    scope,
    folderWorkspace: null,
    managedWorktree: { repoId: repo.id }
  }))
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchTarget: launch,
    resolveTerminalWorkspaceLaunchScope: async () => scope
  })
  runtime.syncWindowGraph(1, {
    tabs: projected
      ? []
      : [
          {
            tabId: TAB_ID,
            worktreeId: WORKTREE_ID,
            title: 'Source',
            activeLeafId: LEAF_ID,
            layout: { type: 'leaf', leafId: LEAF_ID }
          }
        ],
    leaves: projected
      ? []
      : [
          {
            tabId: TAB_ID,
            worktreeId: WORKTREE_ID,
            leafId: LEAF_ID,
            paneRuntimeId: 1,
            ptyId: SOURCE_PTY
          }
        ],
    mobileSessionTabs: projected
      ? [
          {
            worktree: WORKTREE_ID,
            publicationEpoch: 'projected-source',
            snapshotVersion: 1,
            activeGroupId: 'group',
            activeTabId: `${TAB_ID}::${LEAF_ID}`,
            activeTabType: 'terminal',
            tabGroups: [{ id: 'group', activeTabId: TAB_ID, tabOrder: [TAB_ID] }],
            tabs: [
              {
                type: 'terminal',
                id: `${TAB_ID}::${LEAF_ID}`,
                parentTabId: TAB_ID,
                leafId: LEAF_ID,
                ptyId: SOURCE_PTY,
                title: 'Source',
                isActive: true
              }
            ]
          }
        ]
      : []
  })
  runtime.registerPty(
    SOURCE_PTY,
    WORKTREE_ID,
    null,
    { tabId: TAB_ID, leafId: LEAF_ID, incarnationId: 'initial' },
    false
  )
  const handle = runtime.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, LEAF_ID))
  if (!handle) {
    throw new Error('source handle was not issued')
  }
  const before = structuredClone(session)
  const assertNoMutation = (expected = before) => {
    expect(launch).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
    expect(session).toEqual(expected)
  }
  return {
    runtime,
    controller,
    handle,
    hasPty,
    probe,
    spawn,
    reveal,
    window,
    installWindow,
    repo,
    assertNoMutation,
    getSession: () => session,
    setSession: (next: WorkspaceSessionState) => {
      session = next
    }
  }
}

describe('initial ratio split authoritative liveness', () => {
  it('uses the affirmative synchronous fastpath without requiring an async probe', async () => {
    const h = createHarness(true)
    delete h.controller.probePtyLiveness
    await h.runtime.splitTerminal(h.handle, { ratio: 0.85 })
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.spawn).toHaveBeenCalledOnce()
  })

  it('accepts first cold sync-unknown observation only after authoritative live proof and strict sync revalidation', async () => {
    const h = createHarness()
    h.probe.mockImplementation(async () => {
      h.hasPty.mockReturnValue(true)
      return true
    })
    const split = await h.runtime.splitTerminal(h.handle, { ratio: 0.85 })
    expect(h.probe).toHaveBeenCalledExactlyOnceWith(SOURCE_PTY)
    expect(h.spawn).toHaveBeenCalledOnce()
    expect(h.getSession().terminalLayoutsByTabId[TAB_ID].root).toMatchObject({
      type: 'split',
      ratio: 0.85
    })
    expect(split.leafId).toEqual(expect.any(String))
  })

  it('waits for a pending provider barrier without creating or persisting a pane', async () => {
    const h = createHarness()
    const pending = deferred<boolean | null>()
    h.probe.mockImplementation(async () => {
      const result = await pending.promise
      h.hasPty.mockReturnValue(result)
      return result
    })
    const accepted = h.runtime.splitTerminal(h.handle, { ratio: 0.85 }).then(
      () => true,
      () => false
    )
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce())
    h.assertNoMutation()
    pending.resolve(true)
    expect(await accepted).toBe(true)
    expect(h.spawn).toHaveBeenCalledOnce()
  })

  it.each(['missing', 'false', 'unknown', 'throw', 'sync throw'] as const)(
    'refuses %s authoritative proof before any mutation',
    async (proof) => {
      const h = createHarness()
      if (proof === 'missing') {
        delete h.controller.probePtyLiveness
      }
      if (proof === 'false') {
        h.probe.mockResolvedValue(false)
      }
      if (proof === 'unknown') {
        h.probe.mockResolvedValue(null)
      }
      if (proof === 'throw') {
        h.probe.mockRejectedValue(new Error('provider unavailable'))
      }
      if (proof === 'sync throw') {
        h.probe.mockImplementation(() => {
          throw new Error('provider unavailable')
        })
      }
      await expect(h.runtime.splitTerminal(h.handle, { ratio: 0.85 })).rejects.toThrow(
        '--ratio requires an owned live native local desktop PTY'
      )
      h.assertNoMutation()
    }
  )

  it.each([false, null])(
    'refuses async true when subsequent sync owner proof remains %s',
    async (sync) => {
      const h = createHarness(sync)
      h.probe.mockResolvedValue(true)
      await expect(h.runtime.splitTerminal(h.handle, { ratio: 0.85 })).rejects.toThrow(
        '--ratio requires an owned live native local desktop PTY'
      )
      h.assertNoMutation()
    }
  )

  it('bounds a stalled startup probe and ignores late completion after refusal', async () => {
    vi.useFakeTimers()
    const h = createHarness()
    const pending = deferred<boolean | null>()
    h.probe.mockImplementation(async () => {
      const result = await pending.promise
      h.hasPty.mockReturnValue(result)
      return result
    })
    const rejected = expect(h.runtime.splitTerminal(h.handle, { ratio: 0.85 })).rejects.toThrow(
      '--ratio requires an owned live native local desktop PTY'
    )
    await vi.advanceTimersByTimeAsync(TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS)
    await rejected
    h.assertNoMutation()
    pending.resolve(true)
    await pending.promise
    await Promise.resolve()
    h.assertNoMutation()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    'incarnation',
    'pane',
    'worktree',
    'ownership',
    'reload',
    'window',
    'window replacement',
    'persisted mapping',
    'persisted incarnation',
    'persisted leaf'
  ] as const)('fences %s replacement while authoritative proof is pending', async (change) => {
    const h = createHarness()
    const pending = deferred<boolean | null>()
    h.probe.mockImplementation(async () => {
      const result = await pending.promise
      h.hasPty.mockReturnValue(result)
      return result
    })
    const rejected = expect(h.runtime.splitTerminal(h.handle, { ratio: 0.85 })).rejects.toThrow()
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce())
    if (change === 'incarnation') {
      h.runtime.registerPty(
        SOURCE_PTY,
        WORKTREE_ID,
        null,
        { tabId: TAB_ID, leafId: LEAF_ID, incarnationId: 'replacement' },
        false
      )
    }
    if (change === 'pane') {
      h.runtime.registerPty(
        SOURCE_PTY,
        WORKTREE_ID,
        null,
        { tabId: 'replacement-tab', leafId: LEAF_ID },
        false
      )
    }
    if (change === 'worktree') {
      h.runtime.registerPty(
        SOURCE_PTY,
        'repo-ratio::/replacement',
        null,
        { tabId: TAB_ID, leafId: LEAF_ID },
        false
      )
    }
    if (change === 'ownership') {
      h.repo.connectionId = 'ssh-owner'
    }
    if (change === 'reload') {
      h.runtime.markRendererReloading(1)
    }
    if (change === 'window') {
      h.window.isDestroyed = () => true
    }
    if (change === 'window replacement') {
      h.installWindow({ isDestroyed: () => false, webContents: { isDestroyed: () => false } })
    }
    if (change === 'persisted mapping') {
      const next = structuredClone(h.getSession())
      next.terminalLayoutsByTabId[TAB_ID].ptyIdsByLeafId = { [LEAF_ID]: 'replacement-pty' }
      h.setSession(next)
    }
    if (change === 'persisted incarnation') {
      h.setSession({
        ...h.getSession(),
        terminalPtyIncarnationsByPaneKey: { [makePaneKey(TAB_ID, LEAF_ID)]: 'replacement' }
      })
    }
    if (change === 'persisted leaf') {
      const next = structuredClone(h.getSession())
      next.terminalLayoutsByTabId[TAB_ID].root = {
        type: 'leaf',
        leafId: '22222222-2222-4222-8222-222222222222'
      }
      h.setSession(next)
    }
    const externallyChangedSession = structuredClone(h.getSession())
    pending.resolve(true)
    await rejected
    h.assertNoMutation(externallyChangedSession)
  })

  it.each(['projection loss', 'handle replacement'] as const)(
    'fences runtime-owned %s before launch when live proof was pending',
    async (change) => {
      const h = createHarness(null, true)
      const pending = deferred<boolean | null>()
      h.probe.mockImplementation(async () => {
        const result = await pending.promise
        h.hasPty.mockReturnValue(result)
        return result
      })
      const rejected = expect(h.runtime.splitTerminal(h.handle, { ratio: 0.85 })).rejects.toThrow()
      await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce())
      if (change === 'projection loss') {
        h.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
      } else {
        const replacement = h.runtime.createPreAllocatedTerminalHandle()
        h.runtime.registerPreAllocatedHandleForPty(SOURCE_PTY, replacement)
        h.runtime.registerPty(
          SOURCE_PTY,
          WORKTREE_ID,
          null,
          {
            tabId: TAB_ID,
            leafId: LEAF_ID,
            incarnationId: 'replacement',
            terminalHandle: replacement
          },
          false
        )
        expect(h.runtime.getTerminalHandleForPaneKey(makePaneKey(TAB_ID, LEAF_ID))).toBe(
          replacement
        )
      }
      pending.resolve(true)
      await rejected
      h.assertNoMutation()
    }
  )

  it('independently fences concurrent first splits awaiting the same live owner', async () => {
    const h = createHarness()
    const pending = deferred<boolean | null>()
    h.probe.mockImplementation(async () => {
      const result = await pending.promise
      h.hasPty.mockReturnValue(result)
      return result
    })
    let created = 0
    h.spawn.mockImplementation(async () => ({ id: `ratio-created-${++created}` }))
    const splits = Promise.all([
      h.runtime.splitTerminal(h.handle, { ratio: 0.85 }),
      h.runtime.splitTerminal(h.handle, { ratio: 0.3 })
    ])
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledTimes(2))
    h.assertNoMutation()
    pending.resolve(true)
    const results = await splits
    expect(new Set(results.map((split) => split.leafId)).size).toBe(2)
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(h.reveal).toHaveBeenCalledTimes(2)
    expect(countTerminalLayoutLeaves(h.getSession().terminalLayoutsByTabId[TAB_ID].root)).toBe(3)
  })

  it('preserves omitted-ratio behavior without demanding asynchronous proof', async () => {
    const h = createHarness(true)
    const splitTerminal = vi.fn(
      (_tabId: string, _paneRuntimeId: number, options: { newLeafId?: string }) => {
        if (!options.newLeafId) {
          throw new Error('new split leaf missing')
        }
        h.runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              title: 'Source',
              activeLeafId: options.newLeafId,
              layout: { type: 'leaf', leafId: options.newLeafId }
            }
          ],
          leaves: [
            {
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              leafId: options.newLeafId,
              paneRuntimeId: 2,
              ptyId: 'renderer-created'
            }
          ]
        })
      }
    )
    h.runtime.setNotifier({
      worktreesChanged: () => {},
      reposChanged: () => {},
      activateWorktree: () => {},
      createTerminal: () => {},
      splitTerminal,
      renameTerminal: () => {},
      focusTerminal: () => {},
      closeTerminal: () => {},
      sleepWorktree: () => {},
      terminalFitOverrideChanged: () => {},
      terminalDriverChanged: () => {}
    })
    await h.runtime.splitTerminal(h.handle)
    expect(splitTerminal).toHaveBeenCalledOnce()
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.spawn).not.toHaveBeenCalled()
  })
})
