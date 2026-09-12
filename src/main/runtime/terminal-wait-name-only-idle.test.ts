import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import { RuntimeTerminalWait } from './runtime-terminal-wait'
import { RuntimeTerminalWaiterRegistry } from './runtime-terminal-waiter-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { AgentStatus } from '../../shared/agent-detection'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { FirstPartyAgentStatus } from './tui-idle-evidence'

// #6011: `terminal wait --for tui-idle` returned satisfied in ~0s against a working agent,
// because a Codex/Devin OSC title that carries only the agent NAME is stored as `idle` and
// the wait accepted the stored value. These tests pin which evidence settles the wait,
// which only corroborates, and which vetoes.

const POLL_INTERVAL_MS = 2000
const QUIESCENCE_MS = 3000
const NAME_ONLY_TITLE = 'Codex'
const EXPLICIT_IDLE_TITLE = 'Codex ready'
const HANDLE = 'terminal-1'

function makePty(overrides: Partial<RuntimePtyWorktreeRecord> = {}): RuntimePtyWorktreeRecord {
  return {
    ptyId: 'pty-1',
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastOscTitle: null,
    lastOutputAt: Date.now(),
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  } as unknown as RuntimePtyWorktreeRecord
}

function makeLeaf(overrides: Partial<RuntimeLeafRecord> = {}): RuntimeLeafRecord {
  return {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastOscTitle: null,
    lastOutputAt: Date.now(),
    paneTitle: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  } as unknown as RuntimeLeafRecord
}

function createWait(options: {
  pty?: RuntimePtyWorktreeRecord
  leaf?: RuntimeLeafRecord
  adoptedIdleStatus?: AgentStatus | null
  tabTitle?: string | null
  foreground?: string | null
  agent?: TuiAgent | null
  firstPartyStatus?: FirstPartyAgentStatus
  liveLeaf?: () => RuntimeLeafRecord
}) {
  const waiters = new RuntimeTerminalWaiterRegistry()
  const startVisibleReadProbe = vi.fn()
  const shared = {
    getTabTitle: () => options.tabTitle ?? null,
    getAdoptedPtyIdleStatus: () => options.adoptedIdleStatus ?? null,
    getPaneAgent: () => options.agent ?? null,
    getFirstPartyAgentStatus: () => options.firstPartyStatus ?? null,
    quiescenceMs: QUIESCENCE_MS
  }
  const polls = new RuntimeTerminalIdlePolls({
    ...shared,
    intervalMs: POLL_INTERVAL_MS,
    getForegroundProcess: () => Promise.resolve(options.foreground ?? null),
    getLiveLeaf: (leaf) => options.liveLeaf?.() ?? leaf,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      ...shared,
      defaultTimeoutMs: 60_000,
      getLivePty: () => (options.pty ? { pty: options.pty } : null),
      getLiveLeaf: () => ({ leaf: options.leaf ?? makeLeaf() }),
      startVisibleReadProbe
    },
    waiters,
    polls
  )
  return { wait, waiters, polls, startVisibleReadProbe }
}

function watch(promise: Promise<unknown>) {
  const settled = vi.fn()
  void promise.then(
    (value) => settled({ ok: value }),
    (error) => settled({ error: (error as Error).message })
  )
  return settled
}

/** Keeps the record "streaming": output stays younger than the quiescence window. */
async function advanceWhileStreaming(
  record: { lastOutputAt: number | null },
  ticks: number
): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    record.lastOutputAt = Date.now()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  }
}

describe('tui-idle evidence ranking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses a stored name-only idle while the pane is still streaming', async () => {
    const pty = makePty({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    const { wait } = createWait({ pty, agent: 'codex' })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))

    await advanceWhileStreaming(pty, 4)
    expect(settled).not.toHaveBeenCalled()
  })

  it('settles a name-only idle once the pane has been quiet for the window', async () => {
    const pty = makePty({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    const { wait } = createWait({ pty, agent: 'codex' })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))

    await advanceWhileStreaming(pty, 2)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(QUIESCENCE_MS + POLL_INTERVAL_MS)
    expect(settled).toHaveBeenCalledWith({ ok: expect.objectContaining({ satisfied: true }) })
  })

  it('settles an explicit idle title immediately, with no quiescence at all', async () => {
    const pty = makePty({ lastAgentStatus: 'idle', lastOscTitle: EXPLICIT_IDLE_TITLE })
    const { wait } = createWait({ pty, agent: 'codex' })
    await expect(
      wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 })
    ).resolves.toMatchObject({ satisfied: true })
  })

  // Why this case exists: tier 1 used to read only the renderer-synced pane title, so a
  // daemon-hosted pane with no renderer dropped its explicit `Codex ready` to the
  // quiescence lane and waited the whole window for a result it already had.
  it('reads an explicit idle title off the record when no renderer published one', async () => {
    const leaf = makeLeaf({
      lastAgentStatus: 'idle',
      lastOscTitle: EXPLICIT_IDLE_TITLE,
      paneTitle: null
    })
    const { wait } = createWait({ leaf, agent: 'codex', tabTitle: null })
    await expect(
      wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 })
    ).resolves.toMatchObject({ satisfied: true })
  })

  it('lets the agent own status stream veto an otherwise-quiet name-only idle', async () => {
    const pty = makePty({
      lastAgentStatus: 'idle',
      lastOscTitle: NAME_ONLY_TITLE,
      lastOutputAt: Date.now() - QUIESCENCE_MS * 4
    })
    const { wait } = createWait({
      pty,
      agent: 'codex',
      firstPartyStatus: { state: 'working', updatedAt: Date.now() }
    })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(settled).not.toHaveBeenCalled()
  })

  // Why the scoping: demoting every name-only title left agents that emit their NAME and
  // nothing else at rest with no settle signal at all. A real idle Grok pane repaints its
  // banner about four times a second forever, so output never quiesces and the wait ran to
  // timeout — a total loss of tui-idle for that provider.
  it('settles immediately for an agent that never emits anything but its name', async () => {
    const pty = makePty({ lastAgentStatus: 'idle', lastOscTitle: 'grok' })
    const { wait } = createWait({ pty, agent: 'grok' })
    await expect(
      wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 })
    ).resolves.toMatchObject({ satisfied: true })
  })

  it('falls back to the title when the pane carries no launch metadata', async () => {
    const pty = makePty({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    const { wait } = createWait({ pty, agent: null })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await advanceWhileStreaming(pty, 3)
    expect(settled).not.toHaveBeenCalled()
  })

  // Why: `syncWindowGraph` rebuilds leaf records, so a poll that keeps reading the record it
  // captured sees a frozen `lastOutputAt`, and its quiescence gate passes while the real pane
  // is still streaming.
  it('tracks the live leaf record across a graph sync instead of a frozen capture', async () => {
    const registered = makeLeaf({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    let live = registered
    const { wait } = createWait({ leaf: registered, agent: 'codex', liveLeaf: () => live })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))

    // The renderer republishes: a brand-new object replaces the captured one.
    live = makeLeaf({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    registered.lastOutputAt = Date.now() - QUIESCENCE_MS * 10
    await advanceWhileStreaming(live, 4)
    expect(settled).not.toHaveBeenCalled()
  })

  it('never settles tui-idle on a permission status', async () => {
    const pty = makePty({ lastAgentStatus: 'permission', lastOscTitle: 'Codex - action required' })
    const { wait } = createWait({ pty, agent: 'codex' })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4 + QUIESCENCE_MS)
    expect(settled).not.toHaveBeenCalled()
  })
})

const E2E_WORKTREE_ID = 'repo-1::/tmp/name-only-idle'
const E2E_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const E2E_PTY_ID = 'pty-name-only-idle'
const WORKING_TITLE = '⠋ Codex'
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

function makeStore() {
  return {
    getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/name-only-idle',
        displayName: 'name-only-idle',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

const E2E_GRAPH = {
  tabs: [
    {
      tabId: 'tab-1',
      worktreeId: E2E_WORKTREE_ID,
      title: 'Agent',
      activeLeafId: E2E_LEAF_ID,
      layout: null
    }
  ],
  leaves: [
    {
      tabId: 'tab-1',
      worktreeId: E2E_WORKTREE_ID,
      leafId: E2E_LEAF_ID,
      paneRuntimeId: 1,
      ptyId: E2E_PTY_ID,
      paneTitle: null,
      title: ''
    }
  ]
}

async function makeRuntime(launchAgent?: TuiAgent) {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: vi.fn(() => true),
    kill: () => true,
    // The agent process stays in the foreground; only its output and title move.
    getForegroundProcess: async () => 'codex',
    listProcesses: vi.fn(async () => []),
    hasPty: () => true
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, E2E_GRAPH as never)
  if (launchAgent) {
    runtime.registerPty(E2E_PTY_ID, E2E_WORKTREE_ID, null, {
      tabId: 'tab-1',
      leafId: E2E_LEAF_ID,
      incarnationId: 'name-only-incarnation',
      agentLaunchAuthority: { launchToken: 'name-only-launch', launchAgent }
    } as never)
  }
  const { terminals } = await runtime.listTerminals(`id:${E2E_WORKTREE_ID}`)
  return { runtime, handle: terminals[0].handle }
}

function oscTitle(title: string): string {
  return `${ESC}]0;${title}${BEL}`
}

describe('tui-idle over the live OSC title pipeline', () => {
  it('does not settle on a name-only title arriving mid-stream', async () => {
    const { runtime, handle } = await makeRuntime('codex')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(WORKING_TITLE)}building\n`, Date.now())

    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 250 })
    // The agent is mid-turn and repaints its title to the bare product name.
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}more output\n`, Date.now())

    await expect(waiting).rejects.toThrow('timeout')
  })

  it('settles when the agent reports idle explicitly', async () => {
    const { runtime, handle } = await makeRuntime('codex')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(WORKING_TITLE)}building\n`, Date.now())

    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}more output\n`, Date.now())
    runtime.onPtyData(E2E_PTY_ID, oscTitle(EXPLICIT_IDLE_TITLE), Date.now())

    await expect(waiting).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
  })

  it('refuses a name-only title observed before the waiter registered', async () => {
    const { runtime, handle } = await makeRuntime('codex')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}output\n`, Date.now())

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 250 })
    ).rejects.toThrow('timeout')
  })

  it('still settles for an agent whose only rest signal is its name', async () => {
    const { runtime, handle } = await makeRuntime('grok')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle('grok')}banner\n`, Date.now())

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
    ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
  })
})
