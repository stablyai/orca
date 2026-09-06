import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID, OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { RuntimeClientEvent } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from '../orca-runtime-test-scenario-builders.spec'
import { DECORATIVE_TITLE_FACT_HEARTBEAT_MS } from '../decorative-title-fact-emission'

describe('terminal side-effect fact channel', () => {
  it('defers desktop-only output scanners until a headless runtime is promoted', () => {
    const { runtime, batches } = createSideEffectRuntime()
    const trackerEntries = (
      runtime as unknown as {
        ptyTitleTrackersByPtyId: Map<string, { commandCodeDetector: unknown }>
      }
    ).ptyTitleTrackersByPtyId
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    runtime.onPtyData('pty-1', '\x07', 100)

    expect(batches).toEqual([])
    expect(trackerEntries.get('pty-1')?.commandCodeDetector).toBeNull()

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.onPtyData('pty-1', '\x07', 101)

    expect(batches.flatMap((batch) => batch.facts)).toEqual([{ kind: 'bell' }])
    expect(trackerEntries.get('pty-1')?.commandCodeDetector).not.toBeNull()

    runtime.markGraphUnavailable(1)
    runtime.onPtyData('pty-1', '\x07', 102)

    expect(batches).toHaveLength(1)
    expect(trackerEntries.get('pty-1')?.commandCodeDetector).toBeNull()
  })

  it('forwards facts over the shared client-event stream without a desktop renderer', () => {
    const runtime = new OrcaRuntimeService(store)
    const events: RuntimeClientEvent[] = []
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const unsubscribe = runtime.onClientEvent((event) => events.push(event))

    runtime.onPtyData('pty-remote', '\x1b]0;Codex working\x07\x07', 100)

    expect(events).toEqual([
      {
        type: 'terminalSideEffects',
        batch: {
          ptyId: 'pty-remote',
          seq: 19,
          facts: [
            {
              kind: 'title',
              normalizedTitle: 'Codex working',
              rawTitle: 'Codex working'
            },
            { kind: 'agent-working' },
            { kind: 'bell' }
          ]
        }
      }
    ])

    unsubscribe()
    runtime.onPtyData('pty-remote', '\x07', 101)
    expect(events).toHaveLength(1)
  })

  it('bounds decorative title delivery per paired client below the local heartbeat', () => {
    // Why the clock steps: main throttles decorative repeats on the local fact stream, so each
    // round must clear that heartbeat for the per-client gate to be what collapses them here.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { runtime, batches } = createSideEffectRuntime()
      const firstClientEvents: RuntimeClientEvent[] = []
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.onClientEvent((event) => firstClientEvents.push(event))

      const ptyIds = Array.from({ length: 64 }, (_, index) => `pty-remote-${index}`)
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      const stepPastHeartbeat = (): void => {
        vi.setSystemTime(new Date(Date.now() + DECORATIVE_TITLE_FACT_HEARTBEAT_MS))
      }
      for (const ptyId of ptyIds) {
        runtime.ingestSyntheticTitleFrame(ptyId, `\x1b]0;${frames[0]} Cursor Agent\x07`)
      }
      firstClientEvents.length = 0

      for (const frame of frames.slice(1)) {
        stepPastHeartbeat()
        for (const ptyId of ptyIds) {
          runtime.ingestSyntheticTitleFrame(ptyId, `\x1b]0;${frame} Cursor Agent\x07`)
        }
      }

      expect(firstClientEvents).toEqual([])
      expect(batches).toHaveLength(ptyIds.length * frames.length)

      const bellChunk = `\x1b]0;${frames.at(-1)} Cursor Agent\x07\x07`
      runtime.onPtyData(ptyIds[0], bellChunk, 1)
      expect(firstClientEvents).toEqual([
        expect.objectContaining({
          type: 'terminalSideEffects',
          batch: expect.objectContaining({ facts: [{ kind: 'bell' }] })
        })
      ])
      firstClientEvents.length = 0

      const secondClientEvents: RuntimeClientEvent[] = []
      runtime.onClientEvent((event) => secondClientEvents.push(event))
      stepPastHeartbeat()
      for (const ptyId of ptyIds) {
        runtime.ingestSyntheticTitleFrame(ptyId, `\x1b]0;${frames[0]} Cursor Agent\x07`)
      }

      expect(firstClientEvents).toEqual([])
      expect(secondClientEvents).toHaveLength(ptyIds.length)

      // A real title change is never throttled — no clock step needed.
      for (const ptyId of ptyIds) {
        runtime.ingestSyntheticTitleFrame(ptyId, '\x1b]0;Cursor ready\x07')
      }
      expect(firstClientEvents).toHaveLength(ptyIds.length)
      expect(secondClientEvents).toHaveLength(ptyIds.length * 2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('omits terminalSideEffects from non-consuming listeners while other events still flow', () => {
    const runtime = new OrcaRuntimeService(store)
    const desktopEvents: RuntimeClientEvent[] = []
    const mobileEvents: RuntimeClientEvent[] = []
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.onClientEvent((event) => desktopEvents.push(event))
    runtime.onClientEvent((event) => mobileEvents.push(event), {
      consumesTerminalSideEffects: false
    })

    runtime.onPtyData('pty-remote', '\x1b]0;Codex working\x07', 100)
    runtime.notifyBranchRenamed(TEST_REPO_ID)

    expect(desktopEvents.map((event) => event.type)).toEqual([
      'terminalSideEffects',
      'worktreesChanged'
    ])
    expect(mobileEvents.map((event) => event.type)).toEqual(['worktreesChanged'])
  })

  it('keeps a phone-only host producing title state without emitting batches to it', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-a`
      const runtime = new OrcaRuntimeService(store)
      const mobileEvents: RuntimeClientEvent[] = []
      const trackerEntries = (
        runtime as unknown as {
          ptyTitleTrackersByPtyId: Map<string, { commandCodeDetector: unknown }>
        }
      ).ptyTitleTrackersByPtyId
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      runtime.onClientEvent((event) => mobileEvents.push(event), {
        consumesTerminalSideEffects: false
      })
      const unsubscribeDesktop = runtime.onClientEvent(() => {})

      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData(ptyId, 'output without a title\r\n', 101)
      // The phone is still subscribed: disposing trackers on this edge would cancel
      // its armed stale-working-title timer and strand a 'working' spinner (#1437).
      unsubscribeDesktop()

      await vi.advanceTimersByTimeAsync(3_000)

      expect(trackerEntries.has(ptyId)).toBe(true)
      expect(trackerEntries.get(ptyId)?.commandCodeDetector).toBeNull()
      expect((await runtime.listTerminals()).terminals[0]).toMatchObject({ title: 'Codex' })
      expect(mobileEvents.some((event) => event.type === 'terminalSideEffects')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips a listener unsubscribed mid-fan-out even with mobile exclusions active', () => {
    const runtime = new OrcaRuntimeService(store)
    const lateEvents: RuntimeClientEvent[] = []
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.onClientEvent(() => {}, { consumesTerminalSideEffects: false })
    runtime.onClientEvent(() => {
      unsubscribeLate()
    })
    const unsubscribeLate = runtime.onClientEvent((event) => lateEvents.push(event))

    runtime.onPtyData('pty-remote', '\x1b]0;Codex working\x07', 100)

    expect(lateEvents).toEqual([])
  })

  it('emits one batched event per chunk with facts in byte order and attribution', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    const chunk = '\x1b]0;Codex working\x07response\x1b]0;Codex done\x07\x07'
    runtime.onPtyData('pty-1', chunk, 100)

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      ptyId: 'pty-1',
      seq: chunk.length,
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'tab-1',
      paneKey: 'tab-1:1'
    })
    expect(batches[0].replay).toBeUndefined()
    expect(batches[0].facts).toEqual([
      { kind: 'title', normalizedTitle: 'Codex working', rawTitle: 'Codex working' },
      { kind: 'agent-working' },
      { kind: 'title', normalizedTitle: 'Codex done', rawTitle: 'Codex done' },
      { kind: 'agent-idle', title: 'Codex done' },
      { kind: 'bell' }
    ])
  })

  it('keeps per-PTY ordering across chunks and accumulates seq', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)

    expect(batches.map((batch) => batch.facts[0]?.kind)).toEqual(['title', 'title'])
    expect(batches[0].seq).toBeLessThan(batches[1].seq)
  })

  it('emits only agent-status facts for status-only chunks', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    // Plain output and a BEL-terminated non-title OSC stay fact-free.
    runtime.onPtyData('pty-1', 'plain output\r\n', 100)
    runtime.onPtyData('pty-1', '\x1b]7;file://host', 101)
    runtime.onPtyData('pty-1', '/tmp\x07', 102)
    runtime.onPtyData('pty-1', '\x1b]9999;{"state":"working","agentType":"codex"}\x07', 103)

    expect(batches).toHaveLength(1)
    expect(batches[0].facts).toEqual([
      {
        kind: 'agent-status',
        payload: expect.objectContaining({ state: 'working', agentType: 'codex' })
      }
    ])
  })

  it('emits the stale-working-title rewrite as between-chunk fact batches', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, batches } = createSideEffectRuntime()
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData('pty-1', 'output without a title\r\n', 101)
      batches.length = 0

      await vi.advanceTimersByTimeAsync(3_000)

      // staleWorkingTitleClear tells the renderer to clear state without scheduling a task-complete notification the unthrottled timer didn't earn.
      expect(batches.flatMap((batch) => batch.facts)).toEqual([
        {
          kind: 'title',
          normalizedTitle: 'Codex',
          rawTitle: 'Codex',
          staleWorkingTitleClear: true
        },
        { kind: 'agent-idle', title: 'Codex', staleWorkingTitleClear: true }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('ingests synthetic title frames without touching the byte pipeline', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Cursor Agent\x07')

    expect(batches).toHaveLength(1)
    expect(batches[0].facts).toEqual([
      { kind: 'title', normalizedTitle: '⠋ Cursor Agent', rawTitle: '⠋ Cursor Agent' },
      // Synthesized spinner classifies as working — agent facts derive from synthetic frames the same as from real bytes.
      { kind: 'agent-working' }
    ])
    // Synthetic frames are fabricated by main, so they must not advance the metered output sequence the renderer ACK budget uses.
    expect(runtime.getPtyOutputSequence('pty-1')).toBe(0)
  })

  it('emits live Cursor identity without storing it as liveness evidence', async () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '\x1b]0;Cursor Agent\x07', 100)

    expect(batches.flatMap((batch) => batch.facts)).toEqual([
      { kind: 'title', normalizedTitle: 'Cursor Agent', rawTitle: 'Cursor Agent' }
    ])
    expect((await runtime.listTerminals()).terminals[0].title).not.toBe('Cursor Agent')
    expect(runtime.getTerminalSideEffectSnapshot('pty-1')).toMatchObject({
      facts: [{ kind: 'title', normalizedTitle: 'Cursor Agent', rawTitle: 'Cursor Agent' }]
    })
  })

  it('keeps live Cursor identity in mobile titles without making it agent liveness', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'epoch-cursor',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              ptyId: 'pty-1',
              title: 'Terminal 1',
              isActive: true
            }
          ]
        }
      ]
    })

    runtime.onPtyData('pty-1', '\x1b]0;Cursor Agent\x07', 100)

    const terminal = (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]
    expect(terminal).toMatchObject({ type: 'terminal', title: 'Cursor Agent' })
    expect(terminal).not.toHaveProperty('agentStatus')
  })

  it('lets an explicit terminal rename override cached Cursor identity and restores it after clearing', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`)

    runtime.onPtyData('pty-1', '\x1b]0;Cursor Agent\x07', 100)
    const mobileTerminal = (
      await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    ).tabs.find((tab) => tab.type === 'terminal')
    if (mobileTerminal?.type !== 'terminal' || !mobileTerminal.terminal) {
      throw new Error('expected mobile terminal handle')
    }
    expect(mobileTerminal.terminal).toBe(created.handle)

    await runtime.renameTerminal(mobileTerminal.terminal, 'Pinned Cursor')
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]).toMatchObject({
      type: 'terminal',
      title: 'Pinned Cursor'
    })

    await runtime.renameTerminal(mobileTerminal.terminal, null)
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]).toMatchObject({
      type: 'terminal',
      title: 'Cursor Agent'
    })
  })

  it('confirms title-based agent exits against the foreground process', async () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    runtime.onPtyData('pty-1', '\x1b]0;⠋ bichir\x07', 100)
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    batches.length = 0

    const getForegroundProcess = vi.fn().mockResolvedValueOnce('codex')
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.onPtyData('pty-1', '\x1b]0;bichir\x07', 101)

    await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(batches.flatMap((batch) => batch.facts)).toEqual([
        { kind: 'title', normalizedTitle: 'bichir', rawTitle: 'bichir' }
      ])
    )
    await vi.waitFor(() =>
      expect(
        (
          runtime as unknown as {
            ptyForegroundProcessReads: Map<string, unknown>
          }
        ).ptyForegroundProcessReads.size
      ).toBe(0)
    )
    await Promise.resolve()

    getForegroundProcess.mockResolvedValueOnce('zsh')
    runtime.onPtyData('pty-1', '\x1b]0;other cwd\x07', 102)

    await vi.waitFor(() =>
      expect(batches.flatMap((batch) => batch.facts)).toContainEqual({ kind: 'agent-exited' })
    )
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('does not confirm an agent exit from a foreground read predating its title', async () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)
    let resolveStaleRead!: (process: string) => void
    const staleRead = new Promise<string>((resolve) => {
      resolveStaleRead = resolve
    })
    const getForegroundProcess = vi.fn().mockReturnValueOnce(staleRead).mockResolvedValueOnce('zsh')
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    runtime.onPtyData('pty-1', '\x1b]0;bichir\x07', 100)
    expect(getForegroundProcess).toHaveBeenCalledOnce()

    resolveStaleRead('codex')

    await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(batches.flatMap((batch) => batch.facts)).toContainEqual({ kind: 'agent-exited' })
    )
  })

  it('treats synchronous foreground read failures as unavailable', async () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    const getForegroundProcess = vi.fn(() => {
      throw new TypeError('getForegroundProcess is unavailable')
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })

    runtime.onPtyData('pty-1', '\x1b]0;bichir\x07', 100)

    await vi.waitFor(() =>
      expect(batches.flatMap((batch) => batch.facts)).toContainEqual({ kind: 'agent-exited' })
    )
    expect(getForegroundProcess).toHaveBeenCalledOnce()
  })

  it('aligns a restored session and pre-response bytes to the provider sequence', async () => {
    const { runtime } = createSideEffectRuntime()

    // Simulate a stream-socket byte winning the race with the spawn response.
    runtime.onPtyData('pty-restored', 'queued', 100)
    expect(
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-restored',
        { value: 900, generation: 'continued' },
        0
      )
    ).toBe(906)
    runtime.onPtyData('pty-restored', 'fresh', 101)

    expect(runtime.getPtyOutputSequence('pty-restored')).toBe(911)
    await expect(runtime.serializeMainTerminalBuffer('pty-restored')).resolves.toMatchObject({
      data: expect.stringContaining('queuedfresh'),
      seq: 911,
      source: 'headless'
    })
  })

  it('does not double a fresh daemon sequence on same-main reattach', () => {
    const { runtime } = createSideEffectRuntime()

    expect(
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-fresh',
        { value: 0, generation: 'reset' },
        0
      )
    ).toBe(0)
    runtime.onPtyData('pty-fresh', 'fresh output', 100)
    const sequenceBeforeReattach = runtime.getPtyOutputSequence('pty-fresh')

    expect(
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-fresh',
        { value: sequenceBeforeReattach, generation: 'continued' },
        sequenceBeforeReattach
      )
    ).toBe(sequenceBeforeReattach)
  })

  it('does not jump ahead of delayed bytes covered by a reattach snapshot', () => {
    const { runtime } = createSideEffectRuntime()
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-delayed',
      { value: 0, generation: 'reset' },
      0
    )
    runtime.onPtyData('pty-delayed', 'before', 100)
    const sequenceBeforeReattach = runtime.getPtyOutputSequence('pty-delayed')
    const delayedCoveredBytes = 'queued'

    expect(
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-delayed',
        {
          value: sequenceBeforeReattach + delayedCoveredBytes.length,
          generation: 'continued'
        },
        sequenceBeforeReattach
      )
    ).toBe(sequenceBeforeReattach)
    runtime.onPtyData('pty-delayed', delayedCoveredBytes, 101)

    expect(runtime.getPtyOutputSequence('pty-delayed')).toBe(
      sequenceBeforeReattach + delayedCoveredBytes.length
    )
  })

  it('retains bytes emitted before a fresh daemon spawn resolves', async () => {
    const { runtime } = createSideEffectRuntime()
    const earlyOutput = '\x1b]0;Fresh shell\x07early prompt'
    runtime.onPtyData('pty-fresh', earlyOutput, 100)

    expect(
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-fresh',
        { value: 0, generation: 'reset' },
        0
      )
    ).toBe(earlyOutput.length)

    await expect(runtime.serializeMainTerminalBuffer('pty-fresh')).resolves.toMatchObject({
      data: expect.stringContaining('early prompt'),
      lastTitle: 'Fresh shell',
      seq: earlyOutput.length
    })
  })

  it('drops stale headless state without rewinding the runtime sequence', async () => {
    const { runtime } = createSideEffectRuntime()
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-restarted',
      { value: 0, generation: 'reset' },
      0
    )
    runtime.onPtyData('pty-restarted', 'old generation', 100)
    const sequenceBeforeRespawn = runtime.getPtyOutputSequence('pty-restarted')

    expect(
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-restarted',
        { value: 0, generation: 'reset' },
        sequenceBeforeRespawn
      )
    ).toBe(sequenceBeforeRespawn)
    runtime.onPtyData('pty-restarted', 'new generation', 101)

    await expect(runtime.serializeMainTerminalBuffer('pty-restarted')).resolves.toMatchObject({
      data: expect.not.stringContaining('old generation'),
      seq: sequenceBeforeRespawn + 'new generation'.length
    })
  })

  it('keeps active listener sequences monotonic across a daemon reset', () => {
    const { runtime } = createSideEffectRuntime()
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-reset',
      { value: 0, generation: 'reset' },
      0
    )
    runtime.onPtyData('pty-reset', 'old', 100)
    const sequenceBeforeRespawn = runtime.getPtyOutputSequence('pty-reset')
    const observedSequences: number[] = []
    runtime.subscribeToTerminalData('pty-reset', (_data, meta) => {
      if (typeof meta?.seq === 'number') {
        observedSequences.push(meta.seq)
      }
    })

    runtime.onPtyData('pty-reset', 'early', 101)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-reset',
      { value: 0, generation: 'reset' },
      sequenceBeforeRespawn
    )
    runtime.onPtyData('pty-reset', 'later', 102)

    expect(observedSequences).toEqual([
      sequenceBeforeRespawn + 'early'.length,
      sequenceBeforeRespawn + 'early'.length + 'later'.length
    ])
  })

  it('carries the synthetic permission BEL as a bell fact', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Cursor needs your input\x07\x07')

    expect(batches[0].facts.at(0)).toMatchObject({ kind: 'title' })
    expect(batches[0].facts.at(-1)).toEqual({ kind: 'bell' })
  })

  it('emits command-finished facts with best-effort exit codes across chunk splits', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', 'output\x1b]133;D;13', 100)
    expect(batches).toEqual([])
    runtime.onPtyData('pty-1', '0\x07prompt $ ', 101)
    runtime.onPtyData('pty-1', '\x1b]133;D\x07', 102)

    expect(batches.flatMap((batch) => batch.facts)).toEqual([
      { kind: 'command-finished', exitCode: 130 },
      { kind: 'command-finished', exitCode: null }
    ])
  })

  it('emits pr-link facts once per URL with batch attribution', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', 'PR https://github.com/acme/orca/pull/4', 100)
    runtime.onPtyData('pty-1', '2\r\nand https://github.com/acme/orca/pull/43 done\r\n', 101)
    // Repeated URL: deduped per PTY, like the renderer byte detector.
    runtime.onPtyData('pty-1', 'again https://github.com/acme/orca/pull/42\r\n', 102)

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      ptyId: 'pty-1',
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'tab-1'
    })
    expect(batches[0].facts).toEqual([
      {
        kind: 'pr-link',
        link: {
          url: 'https://github.com/acme/orca/pull/42',
          slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
          number: 42
        }
      },
      {
        kind: 'pr-link',
        link: {
          url: 'https://github.com/acme/orca/pull/43',
          slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
          number: 43
        }
      }
    ])
  })
})
