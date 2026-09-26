import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimeTerminalAgentPresence } from './runtime-terminal-agent-presence'
import { RuntimeTerminalAgentStatusQuery } from './runtime-terminal-agent-status-query'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import type { PtyProviderBufferSnapshot } from '../providers/types'
import type { PtyProcessInfo } from '../providers/pty-process-info'

// #22809: a headless `orca serve` restart adopts the daemon sessions that survived it from the
// controller inventory. No spawn runs, so no restore payload is seeded, and an idle agent read as
// title null / no identity / status null until it happened to report again.

const WORKTREE_ID = 'repo-1::/tmp/adopted-title-worktree'
const PTY_ID = `${WORKTREE_ID}@@session-adopted`
const INCARNATION = '40000000-0000-4000-8000-000000000001'
const REPLACEMENT = '40000000-0000-4000-8000-000000000002'
const CLAUDE_IDLE_TITLE = '✳ Claude Code'
const GEMINI_PERMISSION_TITLE = '✋ Gemini CLI'

// A renderer pane bound to the adopted session, as a desktop client's graph sync publishes it.
const PANE_GRAPH = {
  tabs: [
    {
      tabId: 'tab-1',
      worktreeId: WORKTREE_ID,
      title: 'Agent',
      activeLeafId: 'leaf-1',
      layout: null
    }
  ],
  leaves: [
    {
      tabId: 'tab-1',
      worktreeId: WORKTREE_ID,
      leafId: 'leaf-1',
      paneRuntimeId: 1,
      ptyId: PTY_ID,
      paneTitle: null,
      title: ''
    }
  ]
} satisfies RuntimeSyncWindowGraph

function processRow(overrides: Partial<PtyProcessInfo> = {}): PtyProcessInfo {
  // The daemon inventory cannot carry a title; it reports a fixed placeholder.
  return {
    id: PTY_ID,
    cwd: '/tmp/adopted-title-worktree',
    title: 'shell',
    worktreeId: WORKTREE_ID,
    incarnationId: INCARNATION,
    ...overrides
  }
}

function providerSnapshot(
  overrides: Partial<PtyProviderBufferSnapshot> = {}
): PtyProviderBufferSnapshot {
  return {
    data: 'old visible screen\r\n',
    cols: 80,
    rows: 24,
    seq: 10,
    source: 'headless',
    lastTitle: CLAUDE_IDLE_TITLE,
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type Snapshot = PtyProviderBufferSnapshot | null

// Why a subclass: the assertions read the runtime's own PTY records, which are protected.
class AdoptedTitleRuntime extends OrcaRuntimeService {
  record(ptyId = PTY_ID) {
    return this.ptysById.get(ptyId)
  }

  primaryLeaf(ptyId = PTY_ID) {
    return this.getPrimaryLeafForPty(ptyId)
  }
}

function createHeadlessRuntime(options: {
  serializeProviderBuffer: (ptyId: string, opts?: { scrollbackRows?: number }) => Promise<Snapshot>
  listProcesses?: () => Promise<PtyProcessInfo[]>
  getForegroundProcess?: () => Promise<string | null>
  confirmForegroundProcess?: () => Promise<string | null>
}) {
  const runtime = new AdoptedTitleRuntime()
  const serializeProviderBuffer = vi.fn(options.serializeProviderBuffer)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: options.getForegroundProcess ?? (async () => null),
    ...(options.confirmForegroundProcess
      ? { confirmForegroundProcess: options.confirmForegroundProcess }
      : {}),
    hasPty: () => true,
    listProcesses: vi.fn(options.listProcesses ?? (async () => [processRow()])),
    serializeProviderBuffer
  })
  return { runtime, serializeProviderBuffer }
}

async function onlyTerminal(runtime: OrcaRuntimeService) {
  const { terminals } = await runtime.listTerminals()
  expect(terminals).toHaveLength(1)
  return terminals[0]!
}

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('inventory-adopted daemon session title seed (#22809)', () => {
  it('restores the title, agent identity and idle status without fabricating output', async () => {
    const { runtime, serializeProviderBuffer } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot()
    })

    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))

    const terminal = await onlyTerminal(runtime)
    expect(terminal.title).toBe(CLAUDE_IDLE_TITLE)
    expect(terminal.agentIdentity).toBe('claude')
    // Historical state only: nothing may read as fresh activity or a frozen screen.
    expect(terminal.lastOutputAt).toBeNull()
    expect(terminal.preview).toBe('')
    expect(runtime.record()?.tailBuffer).toEqual([])
    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'idle'
    })
    // Only the title is used, so the probe asks for no scrollback.
    expect(serializeProviderBuffer).toHaveBeenCalledWith(PTY_ID, { scrollbackRows: 0 })
  })

  it('restores the idle status of a Pi title the same way', async () => {
    const { runtime } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot({ lastTitle: 'π - repo' }),
      // OMP paints Pi's title; a shared title identity group still owns it.
      getForegroundProcess: async () => 'omp'
    })

    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe('π - repo'))

    const terminal = await onlyTerminal(runtime)
    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'idle'
    })
  })

  it('keeps `terminal read` on the fresh provider screen instead of seeding a tail', async () => {
    const { runtime } = createHeadlessRuntime({
      serializeProviderBuffer: async (_ptyId, opts) =>
        providerSnapshot({
          data: opts?.scrollbackRows === 0 ? 'stale adoption screen\r\n' : 'fresh screen\r\n',
          seq: 0
        })
    })

    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))

    const terminal = await onlyTerminal(runtime)
    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['fresh screen'])
  })

  it('lets a live title observed first win over the snapshot title', async () => {
    const snapshot = deferred<Snapshot>()
    const { runtime, serializeProviderBuffer } = createHeadlessRuntime({
      serializeProviderBuffer: () => snapshot.promise
    })

    await runtime.listTerminals()
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    runtime.onPtyData(PTY_ID, '\x1b]0;✳ live title\x07live line\r\n', 1234)
    snapshot.resolve(providerSnapshot({ lastTitle: 'stale snapshot title' }))
    await flushAsyncWork()

    const terminal = await onlyTerminal(runtime)
    expect(terminal.title).toBe('✳ live title')
    expect(terminal.preview).toBe('live line')
    expect(terminal.lastOutputAt).toBe(1234)
  })

  it('stops reporting an agent once a shell owns the foreground behind the restored title', async () => {
    let foreground = 'claude'
    const { runtime } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot(),
      getForegroundProcess: async () => foreground
    })
    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))
    const { handle } = await onlyTerminal(runtime)
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: true,
      status: 'idle'
    })

    // The agent exited to a shell that never reset the title the daemon kept.
    foreground = 'bash'
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: false,
      status: null
    })
    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)

    // A title observed live is current evidence again.
    runtime.onPtyData(PTY_ID, `\x1b]0;${CLAUDE_IDLE_TITLE}\x07`, 2000)
    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  // Same policy as the hook-status path: once the cheap read shows a shell, only fresh evidence of
  // a recognized agent keeps the restored title, so doubt never lets a send type into a shell.
  it.each([
    ['fresh evidence shows the agent', async () => 'bash', async () => 'claude', true],
    ['fresh evidence is unavailable', async () => 'bash', async () => null, false],
    [
      'fresh confirmation fails',
      async () => 'bash',
      () => Promise.reject(new Error('scan')),
      false
    ],
    ['the foreground read fails', () => Promise.reject(new Error('read')), async () => null, true]
  ] as const)(
    'resolves a restored title when %s',
    async (_label, getForegroundProcess, confirmForegroundProcess, running) => {
      const { runtime } = createHeadlessRuntime({
        serializeProviderBuffer: async () => providerSnapshot(),
        getForegroundProcess,
        confirmForegroundProcess
      })
      await runtime.listTerminals()
      await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))
      const { handle } = await onlyTerminal(runtime)

      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
        handle,
        isRunningAgent: running,
        status: running ? 'idle' : null
      })
      await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(running)
    }
  )

  it('verifies the restored title a pane inherits when a renderer binds the adopted session', async () => {
    let foreground = 'claude'
    const { runtime } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot(),
      getForegroundProcess: async () => foreground
    })
    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))
    const { handle: adoptedHandle } = await onlyTerminal(runtime)
    runtime.syncWindowGraph(1, PANE_GRAPH)
    const expectInheritedTitleVerified = async (handle: string) => {
      foreground = 'claude'
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
        handle,
        isRunningAgent: true,
        status: 'idle'
      })
      foreground = 'bash'
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
        handle,
        isRunningAgent: false,
        status: null
      })
      await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
    }

    // Until the next listing rebinds it, the adopted handle resolves through the PTY record and
    // its newly bound primary pane; afterwards it resolves through the pane itself.
    await expectInheritedTitleVerified(adoptedHandle)
    const { handle } = await onlyTerminal(runtime)
    expect(handle).toBe(adoptedHandle)
    await expectInheritedTitleVerified(handle)
  })

  // A PTY-bound handle (what `terminal create` returns) resolves through the PTY record and reads
  // its primary pane's title, so that path must verify the inherited title too.
  it('verifies the inherited title on the PTY-record path when the session has a pane', async () => {
    const { runtime } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot()
    })
    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))
    runtime.syncWindowGraph(1, PANE_GRAPH)
    const pty = runtime.record()!
    const leaf = runtime.primaryLeaf()!
    expect(leaf.lastOscTitle).toBe(CLAUDE_IDLE_TITLE)

    let foreground = 'claude'
    const getForegroundProcess = async () => foreground
    const common = {
      getLiveLeaf: (): never => {
        throw new Error('terminal_handle_stale')
      },
      getPrimaryLeaf: () => leaf,
      getTrackedPty: () => pty,
      getTabTitle: () => null
    }
    const presence = new RuntimeTerminalAgentPresence({
      ...common,
      getLivePty: () => pty,
      getForegroundProcess
    })
    const status = new RuntimeTerminalAgentStatusQuery({
      ...common,
      getController: () => ({ write: () => true, kill: () => true, getForegroundProcess }),
      getLivePty: () => ({ pty }),
      getExplicitStatus: () => null,
      getLifecycleStatus: () => undefined,
      isRunning: (handle) => presence.isRunning(handle)
    })

    await expect(status.getStatus('h')).resolves.toEqual({
      handle: 'h',
      isRunningAgent: true,
      status: 'idle'
    })
    foreground = 'bash'
    await expect(presence.isRunning('h')).resolves.toBe(false)
    await expect(status.getStatus('h')).resolves.toEqual({
      handle: 'h',
      isRunningAgent: false,
      status: null
    })
  })

  it('verifies a restored permission title against the foreground before reporting a prompt', async () => {
    let foreground = 'gemini'
    const { runtime } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot({ lastTitle: GEMINI_PERMISSION_TITLE }),
      getForegroundProcess: async () => foreground
    })
    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(GEMINI_PERMISSION_TITLE))
    const { handle } = await onlyTerminal(runtime)
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: true,
      status: 'permission'
    })
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toEqual({ source: 'title' })

    // A different agent that set no title of its own took over the foreground.
    foreground = 'claude'
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: true,
      status: null
    })
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()

    // The agent exited to a shell that kept the permission title.
    foreground = 'bash'
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: false,
      status: null
    })
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
  })

  // A stale prompt can draw an approval typed into whatever runs now, so only a recognized owner
  // keeps a restored permission title; idle and working titles keep the missing-evidence rule.
  it.each([
    ['the foreground read fails', () => Promise.reject(new Error('read'))],
    ['the foreground is not a recognized agent', async () => 'node'],
    ['the foreground is unknown', async () => null]
  ] as const)(
    'withholds a restored permission prompt when %s',
    async (_label, getForegroundProcess) => {
      const { runtime } = createHeadlessRuntime({
        serializeProviderBuffer: async () =>
          providerSnapshot({ lastTitle: GEMINI_PERMISSION_TITLE }),
        getForegroundProcess
      })
      await runtime.listTerminals()
      await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(GEMINI_PERMISSION_TITLE))
      const { handle } = await onlyTerminal(runtime)

      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
        handle,
        isRunningAgent: true,
        status: null
      })
      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
    }
  )

  it('compares a restored title with the agent fresh evidence finds behind a cached shell', async () => {
    const { runtime } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot({ lastTitle: GEMINI_PERMISSION_TITLE }),
      getForegroundProcess: async () => 'bash',
      confirmForegroundProcess: async () => 'claude'
    })
    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(GEMINI_PERMISSION_TITLE))
    const { handle } = await onlyTerminal(runtime)

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: true,
      status: null
    })
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
  })

  it('rereads the title when a live one lands while the restored one is verified', async () => {
    let liveTitleOnRead: string | null = null
    const { runtime } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot({ lastTitle: GEMINI_PERMISSION_TITLE }),
      getForegroundProcess: async () => {
        if (liveTitleOnRead) {
          runtime.onPtyData(PTY_ID, `\x1b]0;${liveTitleOnRead}\x07`, 3000)
          liveTitleOnRead = null
        }
        return 'gemini'
      }
    })
    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(GEMINI_PERMISSION_TITLE))
    const { handle } = await onlyTerminal(runtime)

    // The agent resumed work while the foreground read verifying the permission title was pending.
    liveTitleOnRead = '⠋ Gemini CLI'
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: true,
      status: 'working'
    })
  })

  it('probes only records that have seen neither output nor a title', async () => {
    const livePtyId = `${WORKTREE_ID}@@session-live`
    const titledPtyId = `${WORKTREE_ID}@@session-titled`
    const { runtime, serializeProviderBuffer } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot({ lastTitle: 'stale snapshot title' }),
      listProcesses: async () => [
        processRow({ id: livePtyId }),
        processRow({ id: titledPtyId }),
        processRow()
      ]
    })
    runtime.onPtyData(livePtyId, 'live line\r\n', 99)
    runtime.onPtyData(titledPtyId, '\x1b]0;live title\x07', 100)

    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe('stale snapshot title'))

    expect(serializeProviderBuffer.mock.calls).toEqual([[PTY_ID, { scrollbackRows: 0 }]])
    expect(runtime.record(livePtyId)?.lastOscTitle).toBeNull()
    expect(runtime.record(titledPtyId)?.lastOscTitle).toBe('live title')
  })

  it.each([
    ['a null snapshot', async () => null],
    ['a snapshot with no title', async () => providerSnapshot({ lastTitle: undefined })],
    [
      'a rejected snapshot',
      async () => {
        throw new Error('provider_unavailable')
      }
    ]
  ] as const)('treats %s as a silent no-op', async (_label, serialize) => {
    const { runtime, serializeProviderBuffer } = createHeadlessRuntime({
      serializeProviderBuffer: serialize
    })

    await runtime.listTerminals()
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    await flushAsyncWork()

    const terminal = await onlyTerminal(runtime)
    expect(terminal.title).toBeNull()
    expect(terminal.preview).toBe('')
    expect(terminal.lastOutputAt).toBeNull()
  })

  describe('retrying a title-less answer', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1_000_000)
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    async function refreshAfter(runtime: OrcaRuntimeService, ms: number): Promise<void> {
      vi.setSystemTime(Date.now() + ms)
      await runtime.listTerminals()
      await flushAsyncWork()
    }

    it('spaces retries out and stops after three probes per PTY incarnation', async () => {
      let rows = [processRow()]
      const { runtime, serializeProviderBuffer } = createHeadlessRuntime({
        // Why null: a title-less answer leaves the record seedable, so only the bound stops a refetch.
        serializeProviderBuffer: async () => null,
        listProcesses: async () => rows
      })

      await refreshAfter(runtime, 0)
      await refreshAfter(runtime, 1_000)
      expect(serializeProviderBuffer).toHaveBeenCalledOnce()

      for (let i = 0; i < 4; i += 1) {
        await refreshAfter(runtime, 10_000)
      }
      expect(serializeProviderBuffer).toHaveBeenCalledTimes(3)

      rows = [processRow({ incarnationId: REPLACEMENT })]
      await refreshAfter(runtime, 0)
      expect(serializeProviderBuffer).toHaveBeenCalledTimes(4)
    })

    it('recovers the title when an earlier snapshot came back empty', async () => {
      // The production provider maps a failed snapshot to null.
      const answers: Snapshot[] = [null, providerSnapshot()]
      const { runtime, serializeProviderBuffer } = createHeadlessRuntime({
        serializeProviderBuffer: async () => answers.shift() ?? null
      })

      await refreshAfter(runtime, 0)
      expect(runtime.record()?.lastOscTitle).toBeNull()

      await refreshAfter(runtime, 10_000)
      await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))
      await refreshAfter(runtime, 10_000)
      expect(serializeProviderBuffer).toHaveBeenCalledTimes(2)
    })
  })

  it('keeps one probe in flight per PTY incarnation', async () => {
    const snapshot = deferred<Snapshot>()
    const { runtime, serializeProviderBuffer } = createHeadlessRuntime({
      serializeProviderBuffer: () => snapshot.promise
    })

    await runtime.listTerminals()
    await runtime.listTerminals()
    await flushAsyncWork()
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()

    snapshot.resolve(providerSnapshot())
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))
  })

  it('drops a snapshot whose PTY was replaced while it was in flight', async () => {
    const snapshot = deferred<Snapshot>()
    let rows = [processRow()]
    const { runtime, serializeProviderBuffer } = createHeadlessRuntime({
      serializeProviderBuffer: vi
        .fn<(ptyId: string) => Promise<Snapshot>>()
        .mockImplementationOnce(() => snapshot.promise)
        .mockResolvedValue(null),
      listProcesses: async () => rows
    })

    await runtime.listTerminals()
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalledOnce())
    rows = [processRow({ incarnationId: REPLACEMENT })]
    await runtime.listTerminals()
    snapshot.resolve(providerSnapshot())
    await flushAsyncWork()

    expect(runtime.record()?.lastOscTitle).toBeNull()
  })

  // The inventory meets a respawn the runtime never saw under the same PTY id.
  it('restores the successor its own title when the inventory reports a new incarnation', async () => {
    let rows = [processRow()]
    const answers: Snapshot[] = [
      providerSnapshot(),
      providerSnapshot({ lastTitle: GEMINI_PERMISSION_TITLE })
    ]
    const { runtime } = createHeadlessRuntime({
      serializeProviderBuffer: async () => answers.shift() ?? null,
      listProcesses: async () => rows
    })
    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))
    // A bound pane copied the predecessor's title, and a tracked pane title blocks the seed too.
    runtime.syncWindowGraph(1, PANE_GRAPH)
    expect(runtime.primaryLeaf()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE)

    rows = [processRow({ incarnationId: REPLACEMENT })]
    await runtime.listTerminals()

    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(GEMINI_PERMISSION_TITLE))
    expect(runtime.primaryLeaf()?.lastOscTitle).toBe(GEMINI_PERMISSION_TITLE)
  })

  // A renderer pane echoes the restored title as its own pane title and republishes it on sync.
  // The second case restores a title for the first successor, then replaces it too.
  it.each([
    ['one respawn', [null]],
    ['two respawns', [providerSnapshot({ lastTitle: GEMINI_PERMISSION_TITLE }), null]]
  ] as const)(
    'keeps checking a restored title a pane echoes after %s the runtime missed',
    async (_label, successorAnswers) => {
      let rows = [processRow()]
      let foreground = 'claude'
      const answers: Snapshot[] = [providerSnapshot(), ...successorAnswers]
      const { runtime } = createHeadlessRuntime({
        serializeProviderBuffer: async () => answers.shift() ?? null,
        listProcesses: async () => rows,
        getForegroundProcess: async () => foreground
      })
      await runtime.listTerminals()
      await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))
      runtime.syncWindowGraph(1, {
        ...PANE_GRAPH,
        leaves: [{ ...PANE_GRAPH.leaves[0], paneTitle: CLAUDE_IDLE_TITLE }]
      })

      // Each successor is replaced in turn; the last is a bare shell that sets no title.
      foreground = 'bash'
      for (const [index, answer] of successorAnswers.entries()) {
        rows = [processRow({ incarnationId: `40000000-0000-4000-8000-00000000010${index}` })]
        await runtime.listTerminals()
        await flushAsyncWork()
        expect(runtime.record()?.lastOscTitle).toBe(answer?.lastTitle ?? null)
      }

      const { handle } = await onlyTerminal(runtime)
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
        handle,
        isRunningAgent: false,
        status: null
      })
      await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
    }
  )

  it('keeps a title observed live when the inventory reports a new incarnation', async () => {
    let rows = [processRow()]
    const { runtime, serializeProviderBuffer } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot({ lastTitle: 'stale snapshot title' }),
      listProcesses: async () => rows
    })
    runtime.onPtyData(PTY_ID, '\x1b]0;✳ live title\x07', 100)
    await runtime.listTerminals()

    rows = [processRow({ incarnationId: REPLACEMENT })]
    await runtime.listTerminals()
    await flushAsyncWork()

    expect(runtime.record()?.lastOscTitle).toBe('✳ live title')
    expect(serializeProviderBuffer).not.toHaveBeenCalled()
  })

  it('never probes SSH relay sessions, whose providers serve no buffer snapshot', async () => {
    const sshPtyId = `ssh:relay-1@@${WORKTREE_ID}@@session-remote`
    const { runtime, serializeProviderBuffer } = createHeadlessRuntime({
      serializeProviderBuffer: async () => providerSnapshot(),
      listProcesses: async () => [processRow({ id: sshPtyId }), processRow()]
    })

    await runtime.listTerminals()
    await vi.waitFor(() => expect(runtime.record()?.lastOscTitle).toBe(CLAUDE_IDLE_TITLE))

    expect(serializeProviderBuffer.mock.calls).toEqual([[PTY_ID, { scrollbackRows: 0 }]])
  })
})
