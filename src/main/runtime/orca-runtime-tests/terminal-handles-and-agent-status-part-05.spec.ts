import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  OrcaRuntimeService,
  makePaneKey,
  waitForMobileSessionTabsEvents
} from '../orca-runtime-test-mocks.spec'
import type { RuntimeMobileSessionTabsResult } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  deferred,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('publishes the hook provider session on a headless mobile tab so native chat can address the transcript', async () => {
    const paneKey = makePaneKey('claude-tab', HEADLESS_LEAF_ID)
    const providerSession = {
      key: 'session_id' as const,
      id: '7dd0c22c-0ff6-45bf-b88a-cea11c34d073',
      transcriptPath: '/transcripts/7dd0c22c.jsonl'
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      // Headless serve has no renderer, so the hook snapshot is the only carrier.
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: 'Hi',
          agentType: 'claude',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'claude-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-claude' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'claude-tab',
      leafId: HEADLESS_LEAF_ID,
      launchAgent: 'claude',
      title: 'Terminal'
    })

    runtime.onPtyData('pty-claude', '\x1b]0;✳ Claude Code\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({ agentType: 'claude', providerSession })
      })
    )
  })

  it('recovers the agent type from the hook row when the pane was launched without an agent hint', async () => {
    // A user who types `claude` in a plain terminal leaves no launchAgent, and headless
    // has no renderer to publish one; without the hook's agentType mobile treats the tab
    // as a non-agent terminal and hides native chat even though the session is addressable.
    const paneKey = makePaneKey('shell-tab', HEADLESS_LEAF_ID)
    const providerSession = {
      key: 'session_id' as const,
      id: 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31',
      transcriptPath: '/transcripts/ac1f6b90.jsonl'
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: 'Hi',
          agentType: 'claude',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'shell-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-shell' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'shell-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    runtime.onPtyData('pty-shell', '\x1b]0;✳ Claude Code\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({ agentType: 'claude', providerSession })
      })
    )
  })

  it('reads one agent-status snapshot per projection, not one per terminal tab', async () => {
    // The getter rebuilds every known pane's payload on each call, so reading it
    // inside the per-tab loop made a projection O(tabs x panes) of pure garbage —
    // worst in headless serve, where every terminal tab takes the hook fallback.
    let snapshotReads = 0
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentProviderSessionSnapshot: () => {
        snapshotReads += 1
        return []
      }
    })
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `pty-${snapshotReads}-${Math.random()}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    for (const tabId of ['fan-a', 'fan-b', 'fan-c']) {
      await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId,
        leafId: HEADLESS_LEAF_ID,
        launchAgent: 'claude',
        title: 'Terminal'
      })
    }
    snapshotReads = 0

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    // Guards the assertion below from passing vacuously on a one-tab projection.
    expect(result.tabs.filter((tab) => tab.type === 'terminal').length).toBeGreaterThan(1)
    expect(snapshotReads).toBe(1)
  })

  it('publishes hook-only identity for a pane that never emitted an agent title', async () => {
    // The hook row is the whole evidence here: no launchAgent hint, no recognized OSC
    // title, so `pty.lastAgentStatus` stays unset. Gating the hook read behind that
    // made the headless carrier unreachable in exactly the case it exists for.
    const paneKey = makePaneKey('quiet-tab', HEADLESS_LEAF_ID)
    const providerSession = {
      key: 'session_id' as const,
      id: 'b91c7e40-5a2d-4f19-9c33-2a7b6e5d4c88',
      transcriptPath: '/transcripts/b91c7e40.jsonl'
    }
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: 'Hi',
          agentType: 'claude',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'quiet-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-quiet' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'quiet-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({ agentType: 'claude', providerSession })
      })
    )
  })

  it('reads a resume-identity-only row the live-agent snapshot filters out', async () => {
    // Pi publishes its session separately from status, and the shared getter drops
    // those rows so they can't read as running agents — leaving native chat with no
    // transcript to address unless the unfiltered snapshot is consulted too.
    const paneKey = makePaneKey('pi-tab', HEADLESS_LEAF_ID)
    const providerSession = {
      key: 'session_id' as const,
      id: '/sessions/pi-1.json',
      transcriptPath: '/sessions/pi-1.json'
    }
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentProviderSessionSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: '',
          agentType: 'pi',
          connectionId: null,
          receivedAt: now + 1,
          stateStartedAt: now + 1,
          tabId: 'pi-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession,
          providerSessionOnly: true
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-pi' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'pi-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({ agentType: 'pi', providerSession })
      })
    )
  })

  it('does not let stale Pi resume metadata claim a plain terminal', async () => {
    const paneKey = makePaneKey('stale-pi-tab', HEADLESS_LEAF_ID)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentProviderSessionSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: '',
          agentType: 'pi',
          connectionId: null,
          receivedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1,
          stateStartedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1,
          tabId: 'stale-pi-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession: {
            key: 'session_id',
            id: '/sessions/stale-pi.json',
            transcriptPath: '/sessions/stale-pi.json'
          },
          providerSessionOnly: true
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-stale-pi' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'stale-pi-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.not.objectContaining({ agentType: 'pi' })
      })
    )
  })

  it('does not claim a stale hook agent owns a pane whose agent has since exited', async () => {
    // `pty.lastAgentStatus` outlives the agent, so an unbounded hook read would keep
    // offering mobile native chat for what is now a plain shell — and point it at a
    // dead transcript. The session id may stay; the ownership claim must not.
    const paneKey = makePaneKey('exited-tab', HEADLESS_LEAF_ID)
    const staleReceivedAt = Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1_000
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: 'Hi',
          agentType: 'claude',
          connectionId: null,
          receivedAt: staleReceivedAt,
          stateStartedAt: staleReceivedAt,
          tabId: 'exited-tab',
          worktreeId: TEST_WORKTREE_ID,
          providerSession: {
            key: 'session_id' as const,
            id: 'd4c3b2a1-0000-4000-8000-000000000001',
            transcriptPath: '/transcripts/d4c3b2a1.jsonl'
          }
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-exited' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'exited-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    runtime.onPtyData('pty-exited', '\x1b]0;✳ Claude Code\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    const tab = result.tabs[0]
    expect(tab?.type).toBe('terminal')
    const agentStatus = tab && 'agentStatus' in tab ? tab.agentStatus : null
    expect(agentStatus?.agentType ?? null).toBeNull()
  })

  it('waits for unknown-launch foreground owner before publishing Pi-compatible mobile status', async () => {
    const foregroundProcess = deferred<string | null>()
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi.fn(() => foregroundProcess.promise)
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
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledWith('pty-typed-omp')
    expect(events).toHaveLength(0)

    foregroundProcess.resolve('omp')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await waitForMobileSessionTabsEvents(events, 1)

    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
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
        ]
      })
    ])

    unsubscribe()
  })

  it('keeps decorative Pi frames queued behind the foreground owner probe', async () => {
    const foregroundProcess = deferred<string | null>()
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi.fn(() => foregroundProcess.promise)
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
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.onPtyData('pty-typed-omp', '\x1b]0;⠋ Pi\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))
    runtime.onPtyData('pty-typed-omp', '\x1b]0;⠙ Pi\x07', 124)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)

    foregroundProcess.resolve('omp')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await waitForMobileSessionTabsEvents(events, 1)

    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            title: '⠋ OMP',
            agentStatus: expect.objectContaining({
              state: 'working',
              agentType: 'omp',
              terminalHandle: terminal.handle,
              terminalTitle: '⠋ OMP'
            })
          })
        ]
      })
    ])

    runtime.onPtyData('pty-typed-omp', '\x1b]0;⠹ Pi\x07', 125)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toHaveLength(1)

    unsubscribe()
  })

  it('coalesces same-status title frames behind one post-title foreground probe', async () => {
    const staleForegroundProcess = deferred<string | null>()
    const freshForegroundProcess = deferred<string | null>()
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi
      .fn()
      .mockReturnValueOnce(staleForegroundProcess.promise)
      .mockReturnValueOnce(freshForegroundProcess.promise)
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
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))
    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi idle\x07', 124)
    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi done\x07', 125)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)

    staleForegroundProcess.resolve(null)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(0)

    freshForegroundProcess.resolve('omp')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await waitForMobileSessionTabsEvents(events, 1)

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
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
        ]
      })
    ])

    unsubscribe()
  })

  it('starts a post-title foreground probe when an older pending probe finds no owner', async () => {
    const staleForegroundProcess = deferred<string | null>()
    const freshForegroundProcess = deferred<string | null>()
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi
      .fn()
      .mockReturnValueOnce(staleForegroundProcess.promise)
      .mockReturnValueOnce(freshForegroundProcess.promise)
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
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    ;(
      runtime as unknown as {
        refreshPtyForegroundAgentFromController: (ptyId: string) => Promise<boolean>
      }
    ).refreshPtyForegroundAgentFromController('pty-typed-omp')
    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)

    staleForegroundProcess.resolve(null)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(0)

    freshForegroundProcess.resolve('omp')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await waitForMobileSessionTabsEvents(events, 1)

    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
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
        ]
      })
    ])

    unsubscribe()
  })

  it('keeps Pi-compatible mobile session status as Pi for an unknown-launch foreground pi PTY', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-pi' })
    const getForegroundProcess = vi.fn(async () => 'pi')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'typed-pi-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })

    runtime.onPtyData('pty-typed-pi', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))

    const result = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(getForegroundProcess).toHaveBeenCalledWith('pty-typed-pi')
    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'Pi ready',
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'pi',
          terminalHandle: terminal.handle,
          terminalTitle: 'Pi ready'
        })
      })
    )
    expect(result.tabs[0]).not.toHaveProperty('launchAgent')
  })

  it('keeps renderer-vetted mobile agent status for custom-titled terminals', async () => {
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
          activeGroupId: null,
          activeTabId: `tab-1::${leafId}`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `tab-1::${leafId}`,
              parentTabId: 'tab-1',
              leafId,
              title: 'claude agents',
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

    expect(result.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        title: 'claude agents',
        agentStatus: expect.objectContaining({
          state: 'working',
          agentType: 'codex',
          paneKey: hostPaneKey
        })
      })
    )
  })
})
