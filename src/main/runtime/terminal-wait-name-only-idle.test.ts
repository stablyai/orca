import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './terminal/wait/terminal-idle-polls'
import { RuntimeTerminalWait } from './terminal/wait/terminal-wait'
import { RuntimeTerminalWaiterRegistry } from './terminal/wait/terminal-waiter-registry'
import { errorMessage, makeTuiIdlePty, makeTuiIdleRuntime } from './tui-idle-wait-test-harness'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import type { AgentStatus } from '../../shared/agent-detection'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { FirstPartyAgentStatus } from './tui-idle-evidence'
import { registerBoundPty } from './bind-first-pane.test-fixture'

// #6011: name-only Codex/Devin titles were stored as idle and prematurely satisfied tui-idle; distinguish settling, corroborating and veto evidence.

const POLL_INTERVAL_MS = 2000
const QUIESCENCE_MS = 3000
const NAME_ONLY_TITLE = 'Codex'
const EXPLICIT_IDLE_TITLE = 'Codex ready'
const HANDLE = 'terminal-1'
// Muse 1.3.0 node-pty capture with echo provider and --trust-workspace; its OSC title stays the bare cwd.
const MUSE_READY_TAIL = [
  '  Muse Code 1.3.0',
  '  Skills: 77 loaded · 1 warning · 28 details hidden (ctrl+o to expand)',
  '── Voice input (⌥ + v to start) ──────────────────────────────────────────',
  '❯ ────────────────────────────────────────────────────────────────────',
  '  muse-spark-1.3 · max · ~/Downloads/interview-coach · YOLO'
]

function createWait(options: {
  pty: RuntimePtyWorktreeRecord
  adoptedIdleStatus?: AgentStatus | null
  foreground?: string | null
  agent?: TuiAgent | null
  firstPartyStatus?: FirstPartyAgentStatus
}) {
  const waiters = new RuntimeTerminalWaiterRegistry()
  const startVisibleReadProbe = vi.fn()
  const shared = {
    getAdoptedPtyIdleStatus: () => options.adoptedIdleStatus ?? null,
    getPaneAgent: () => options.agent ?? null,
    getFirstPartyAgentStatus: () => options.firstPartyStatus ?? null,
    readScreenLines: () => null,
    readVisibleScreen: () => null,
    quiescenceMs: QUIESCENCE_MS
  }
  const polls = new RuntimeTerminalIdlePolls({
    ...shared,
    intervalMs: POLL_INTERVAL_MS,
    getForegroundProcess: () => Promise.resolve(options.foreground ?? null),
    hasCommandPainted: () => true,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      ...shared,
      defaultTimeoutMs: 60_000,
      getTerminalPty: () => ({ pty: options.pty }),
      exitUnsettled: () => false,
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
    (error) => settled({ error: errorMessage(error) })
  )
  return settled
}

/** Keep output younger than the quiescence window. */
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

  it.each([
    ['claude ~/p/repo', false],
    ['Fix the codex launcher', false],
    ['Fix the codex launcher', true]
  ] as const)(
    'keeps a null-agent terminal titled %s pending through streaming (clockless=%s)',
    async (title, clockless) => {
      const pty = makeTuiIdlePty({
        lastAgentStatus: 'idle',
        lastOscTitle: title,
        lastOutputAt: clockless ? null : Date.now()
      })
      const { wait, waiters, polls } = createWait({ pty, agent: null })
      const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).not.toHaveBeenCalled()
      expect(waiters.forPty(pty.ptyId)).toHaveLength(1)
      expect(polls.activeTimerCount).toBe(1)
      if (clockless) {
        await vi.advanceTimersByTimeAsync(QUIESCENCE_MS + POLL_INTERVAL_MS)
        expect(settled).not.toHaveBeenCalled()
      }
      await advanceWhileStreaming(pty, 3)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(QUIESCENCE_MS + POLL_INTERVAL_MS)
      expect(settled).toHaveBeenCalledExactlyOnceWith({
        ok: expect.objectContaining({ satisfied: true })
      })
      expect(waiters.forPty(pty.ptyId)).toHaveLength(0)
      expect(polls.activeTimerCount).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('refuses a stored name-only idle while the pane is still streaming', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    const { wait } = createWait({ pty, agent: 'codex' })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))

    await advanceWhileStreaming(pty, 4)
    expect(settled).not.toHaveBeenCalled()
  })

  it('settles a name-only idle once the pane has been quiet for the window', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    const { wait } = createWait({ pty, agent: 'codex' })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))

    await advanceWhileStreaming(pty, 2)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(QUIESCENCE_MS + POLL_INTERVAL_MS)
    expect(settled).toHaveBeenCalledWith({ ok: expect.objectContaining({ satisfied: true }) })
  })

  it('settles an explicit idle title immediately, with no quiescence at all', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitle: EXPLICIT_IDLE_TITLE })
    const { wait } = createWait({ pty, agent: 'codex' })
    await expect(
      wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 })
    ).resolves.toMatchObject({ satisfied: true })
  })

  it('lets the agent own status stream veto an otherwise-quiet name-only idle', async () => {
    const pty = makeTuiIdlePty({
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

  // Grok emits only its name at rest and repaints about four times/second; demoting every name-only title made it time out.
  it('settles immediately for an agent that never emits anything but its name', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitle: 'grok' })
    const { wait } = createWait({ pty, agent: 'grok' })
    await expect(
      wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 })
    ).resolves.toMatchObject({ satisfied: true })
  })

  it('falls back to the title when the pane carries no launch metadata', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    const { wait } = createWait({ pty, agent: null })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await advanceWhileStreaming(pty, 3)
    expect(settled).not.toHaveBeenCalled()
  })

  it('never settles tui-idle on a permission status', async () => {
    const pty = makeTuiIdlePty({
      lastAgentStatus: 'permission',
      lastOscTitle: 'Codex - action required'
    })
    const { wait } = createWait({ pty, agent: 'codex' })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4 + QUIESCENCE_MS)
    expect(settled).not.toHaveBeenCalled()
  })

  // Muse never updates its cwd title; its ready body settles only after quiet to exclude mid-turn repaints.
  it('settles a Muse ready screen only once the stream goes quiet', async () => {
    const pty = makeTuiIdlePty({
      lastAgentStatus: null,
      lastOscTitle: 'tmp',
      tailBuffer: [...MUSE_READY_TAIL]
    })
    const { wait } = createWait({ pty, agent: 'muse' })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))

    await advanceWhileStreaming(pty, 2)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(QUIESCENCE_MS + POLL_INTERVAL_MS)
    expect(settled).toHaveBeenCalledWith({ ok: expect.objectContaining({ satisfied: true }) })
  })

  it('never settles another agent quoting Muse in its scrollback', async () => {
    const pty = makeTuiIdlePty({
      lastAgentStatus: null,
      lastOscTitle: 'Codex',
      tailBuffer: [...MUSE_READY_TAIL],
      lastOutputAt: Date.now() - QUIESCENCE_MS * 4
    })
    const { wait } = createWait({ pty, agent: 'codex' })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3 + QUIESCENCE_MS)
    expect(settled).not.toHaveBeenCalled()
  })
})

const E2E_WORKTREE_ID = 'repo-1::/tmp/name-only-idle'
const E2E_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const E2E_PTY_ID = 'pty-name-only-idle'
const WORKING_TITLE = '⠋ Codex'
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

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
} satisfies RuntimeSyncWindowGraph

async function makeRuntime(launchAgent?: TuiAgent) {
  const runtime = makeTuiIdleRuntime({
    repoPath: '/tmp/name-only-idle',
    getForegroundProcess: async () => 'codex'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, E2E_GRAPH)
  if (launchAgent) {
    registerBoundPty(runtime, E2E_PTY_ID, E2E_WORKTREE_ID, null, {
      tabId: 'tab-1',
      leafId: E2E_LEAF_ID,
      incarnationId: 'name-only-incarnation',
      agentLaunchAuthority: { launchToken: 'name-only-launch', launchAgent }
    })
  }
  const { terminals } = await runtime.listTerminals(`id:${E2E_WORKTREE_ID}`)
  return { runtime, handle: terminals[0].handle }
}

function oscTitle(title: string): string {
  return `${ESC}]0;${title}${BEL}`
}

describe('tui-idle over the live OSC title pipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not settle on a name-only title arriving mid-stream', async () => {
    const { runtime, handle } = await makeRuntime('codex')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(WORKING_TITLE)}building\n`, Date.now())

    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 250 })
    // The agent is mid-turn and repaints its title to the bare product name.
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}more output\n`, Date.now())

    const assertion = expect(waiting).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(250)
    await assertion
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

    const assertion = expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 250 })
    ).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(250)
    await assertion
  })

  it('still settles for an agent whose only rest signal is its name', async () => {
    const { runtime, handle } = await makeRuntime('grok')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle('grok')}banner\n`, Date.now())

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
    ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
  })

  it('settles a quiet Muse ready screen over the live PTY pipeline', async () => {
    const { runtime, handle } = await makeRuntime('muse')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle('tmp')}${MUSE_READY_TAIL.join('\n')}\n`, Date.now())

    const assertion = expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 15_000 })
    ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await assertion
  }, 20_000)
})
