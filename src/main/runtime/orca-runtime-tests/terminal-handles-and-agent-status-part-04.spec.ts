import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('does not let the active browser webContents steal session focus from terminals', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabList = vi.fn(() => ({
      tabs: [
        {
          browserPageId: 'browser-page-1',
          index: 0,
          url: 'https://example.com/',
          title: 'Live Browser',
          active: true
        }
      ]
    }))
    runtime.setAgentBrowserBridge({ tabList } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'terminal-tab::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'browser',
              id: 'browser-unified-1',
              title: 'Stale Browser',
              browserWorkspaceId: 'browser-workspace-1',
              browserPageId: 'browser-page-1',
              url: 'https://stale.example/',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: false
            },
            {
              type: 'terminal',
              id: 'terminal-tab::pane:1',
              parentTabId: 'terminal-tab',
              leafId: 'pane:1',
              title: 'Terminal 2',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.activeTabId).toBe('terminal-tab::pane:1')
    expect(result.activeTabType).toBe('terminal')
    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'browser',
        id: 'browser-unified-1',
        isActive: false,
        title: 'Live Browser'
      }),
      expect.objectContaining({
        type: 'terminal',
        id: 'terminal-tab::pane:1',
        isActive: true
      })
    ])
  })

  it('publishes terminal surface agent status for paired web clients', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const hostPaneKey = `tab-1:${leafId}`
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'codex [working]',
              agentStatus: {
                state: 'working',
                prompt: 'fix parity',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'codex',
                paneKey: hostPaneKey,
                terminalTitle: 'codex [working]',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        id: `tab-1::${leafId}`,
        status: 'pending-handle',
        terminal: null,
        agentStatus: expect.objectContaining({
          state: 'working',
          prompt: 'fix parity',
          agentType: 'codex',
          paneKey: hostPaneKey
        })
      })
    ])
  })

  it.each([
    {
      behavior: 'fills a missing renderer session',
      hookAgentType: 'codex',
      hookOffset: 0,
      rendererSessionId: null,
      expectedSessionId: 'hook-session'
    },
    {
      behavior: 'replaces a stale renderer session at the same event timestamp',
      hookAgentType: 'codex',
      hookOffset: 0,
      rendererSessionId: 'stale-renderer-session',
      expectedSessionId: 'hook-session'
    },
    {
      behavior: 'preserves a renderer session newer than the hook row',
      hookAgentType: 'codex',
      hookOffset: -1,
      rendererSessionId: 'newer-renderer-session',
      expectedSessionId: 'newer-renderer-session'
    },
    {
      behavior: 'rejects a hook session owned by another agent',
      hookAgentType: 'claude',
      hookOffset: 1,
      rendererSessionId: null,
      expectedSessionId: null
    }
  ] as const)(
    '$behavior',
    async ({ hookAgentType, hookOffset, rendererSessionId, expectedSessionId }) => {
      const leafId = '11111111-1111-4111-8111-111111111111'
      const paneKey = `codex-tab:${leafId}`
      const providerSession = {
        key: 'session_id' as const,
        id: 'hook-session'
      }
      const now = Date.now()
      const runtime = new OrcaRuntimeService(store, undefined, {
        getAgentStatusSnapshot: () => [
          {
            paneKey,
            state: 'done',
            prompt: '',
            agentType: hookAgentType,
            connectionId: null,
            receivedAt: now + hookOffset,
            stateStartedAt: now + hookOffset,
            tabId: 'codex-tab',
            worktreeId: TEST_WORKTREE_ID,
            providerSession
          }
        ]
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: `codex-tab::${leafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `codex-tab::${leafId}`,
                parentTabId: 'codex-tab',
                leafId,
                title: 'Codex',
                launchAgent: 'codex',
                agentStatus: {
                  state: 'working',
                  prompt: 'Reply with MOBILE QA OK and nothing else.',
                  updatedAt: now,
                  stateStartedAt: now,
                  agentType: 'codex',
                  paneKey,
                  stateHistory: [],
                  ...(rendererSessionId
                    ? {
                        providerSession: {
                          key: 'session_id' as const,
                          id: rendererSessionId
                        }
                      }
                    : {})
                },
                isActive: true
              }
            ]
          }
        ]
      })

      const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

      expect(result.tabs[0]).toEqual(
        expect.objectContaining({
          type: 'terminal',
          agentStatus: expect.objectContaining({
            state: 'working',
            prompt: 'Reply with MOBILE QA OK and nothing else.',
            agentType: 'codex'
          })
        })
      )
      if (expectedSessionId) {
        expect(result.tabs[0]).toHaveProperty('agentStatus.providerSession', {
          key: 'session_id',
          id: expectedSessionId
        })
      } else {
        expect(result.tabs[0]).not.toHaveProperty('agentStatus.providerSession')
      }
    }
  )

  it('preserves authoritative OMP identity for Pi-compatible remote terminal snapshots', async () => {
    const runtime = new OrcaRuntimeService(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const hostPaneKey = `tab-1:${leafId}`
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: '\u280b Pi',
              launchAgent: 'omp',
              agentStatus: {
                state: 'working',
                prompt: 'fix parity',
                updatedAt: 1_700_000_000_000,
                stateStartedAt: 1_699_999_999_000,
                agentType: 'pi',
                paneKey: hostPaneKey,
                terminalTitle: '\u280b Pi',
                stateHistory: []
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: '\u280b OMP',
        launchAgent: 'omp',
        agentStatus: expect.objectContaining({
          state: 'working',
          agentType: 'omp',
          paneKey: hostPaneKey,
          terminalTitle: '\u280b OMP'
        })
      })
    )
  })

  it('normalizes a remote OMP title without republishing omitted launch identity', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-omp' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'omp',
      launchAgent: 'omp',
      title: 'OMP',
      activate: true
    })
    const spawnCall = spawn.mock.calls[0]?.[0]
    expect(spawnCall).toEqual(
      expect.objectContaining({
        tabId: expect.any(String),
        leafId: expect.any(String)
      })
    )
    const { tabId, leafId } = spawnCall as { tabId: string; leafId: string }

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: '\u280b π - tmp',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-omp',
          paneTitle: '\u280b π - tmp'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: `${tabId}::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `${tabId}::${leafId}`,
              parentTabId: tabId,
              leafId,
              ptyId: 'pty-omp',
              title: '\u280b π - tmp',
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: '\u280b OMP - tmp'
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('launchAgent')
  })

  it('skips the foreground-process probe when the PTY launch agent is already known', async () => {
    // Why: foregroundAgent is only a fallback when launchAgent is unknown, so probing a launched agent burns a relay round-trip without changing the resolved owner.
    const getForegroundProcess = vi.fn(async () => 'omp')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-omp' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'omp',
      launchAgent: 'omp',
      title: 'OMP',
      activate: true
    })

    runtime.onPtyData('pty-omp', '\x1b]0;⠋ OMP\x07working\n', 100)
    runtime.onPtyData('pty-omp', '\x1b]0;OMP ready\x07idle\n', 200)

    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('probes the foreground process only on a status transition for unknown launch agents', async () => {
    const getForegroundProcess = vi.fn(async () => 'omp')
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    syncSinglePty(runtime, 'pty-bg')
    // Why: each probe dedups while in-flight; settle it before the next frame to prove the gate, not the dedup, suppresses extra probes.
    const settleProbe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

    // Two working frames (spinner churn) collapse to a single status transition.
    runtime.onPtyData('pty-bg', '\x1b]0;⠋ OMP\x07alpha\n', 100)
    runtime.onPtyData('pty-bg', '\x1b]0;⠊ OMP\x07bravo\n', 200)
    await settleProbe()
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)

    // Transition to idle is a second distinct status, so it probes again.
    runtime.onPtyData('pty-bg', '\x1b]0;OMP ready\x07charlie\n', 300)
    await settleProbe()
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)

    // A repeated idle frame is not a transition, so it does not probe again.
    runtime.onPtyData('pty-bg', '\x1b]0;OMP ready\x07delta\n', 400)
    await settleProbe()
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('normalizes Pi-compatible mobile session status to OMP for an unknown-launch foreground omp PTY', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi.fn(async () => 'omp')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'typed-omp-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(getForegroundProcess).toHaveBeenCalledWith('pty-typed-omp')
    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'OMP ready',
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'omp',
          terminalHandle: terminal.handle,
          terminalTitle: 'OMP ready'
        })
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('launchAgent')
  })

  it('preserves host metadata when terminal.create adopts a stable pane owner', async () => {
    const adoptStablePane = vi.fn().mockResolvedValue(null)
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
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      command: "claude 'replacement'",
      adoptedStablePane: expect.anything()
    })
    expect(spawn.mock.calls[1]?.[0]).not.toMatchObject({
      command: expect.stringContaining('--teammate-mode')
    })
  })

  it('releases a stable-pane claim when creation aborts before provider spawn', async () => {
    const releaseClaim = vi.fn()
    const spawn = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      claimStablePaneCreate: vi.fn(() => releaseClaim),
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const abort = new AbortController()
    abort.abort()

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'aborted-stable-pane',
        leafId: HEADLESS_LEAF_ID,
        signal: abort.signal
      })
    ).rejects.toThrow('client_disconnected')

    expect(spawn).not.toHaveBeenCalled()
    expect(releaseClaim).toHaveBeenCalledOnce()
  })
})
