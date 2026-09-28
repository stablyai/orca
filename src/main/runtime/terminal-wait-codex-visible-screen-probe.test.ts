import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import { RuntimeTerminalWait } from './runtime-terminal-wait'
import { RuntimeTerminalWaiterRegistry } from './runtime-terminal-waiter-registry'
import {
  errorMessage,
  makeTuiIdleLeaf,
  makeTuiIdlePty
} from './tui-idle-wait-test-harness'
import type { AgentStatus } from '../../shared/agent-detection'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { FirstPartyAgentStatus } from './tui-idle-evidence'

// #22825: codex 0.157 turned on `tui.fullscreen_transcript`, so its session banner is
// painted into the alternate screen with cursor addressing instead of being written to
// scrollback as newline-separated lines. `buildTerminalWaitText` only ever reads the stream
// tail, so `findCodexReadyPromptIndex` can never match such a pane even when the rendered
// screen already shows the settled prompt. These tests pin the two halves of the fix: the
// wait must ask the provider for its visible screen, and it must keep asking until the waiter
// settles rather than trusting one look at a screen that has not painted yet.

const POLL_INTERVAL_MS = 2000
const QUIESCENCE_MS = 3000
const PROBE_RETRY_MS = 1000
const HANDLE = 'terminal-1'
// A shell line the pane printed before codex took the screen. It is neither empty nor an
// AGY banner, which is exactly the state that used to keep the probe from ever starting.
const SHELL_TAIL = ['$ git status --short']

function createWait(options: {
  pty?: RuntimePtyWorktreeRecord
  leaf?: RuntimeLeafRecord
  adoptedIdleStatus?: AgentStatus | null
  tabTitle?: string | null
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
    getForegroundProcess: () => Promise.resolve(null),
    getLiveLeaf: (leaf: RuntimeLeafRecord) => options.liveLeaf?.() ?? leaf,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      ...shared,
      defaultTimeoutMs: 60_000,
      getLivePty: () => (options.pty ? { pty: options.pty } : null),
      getLiveLeaf: () => ({ leaf: options.leaf ?? makeTuiIdleLeaf() }),
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

function codexPtyOnAlternateScreen() {
  return makeTuiIdlePty({
    lastAgentStatus: 'working',
    tailBuffer: [...SHELL_TAIL]
  })
}

describe('tui-idle visible-screen probe for alternate-screen agents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks for the visible screen on a codex pane whose tail already has shell output', async () => {
    const { wait, startVisibleReadProbe } = createWait({
      pty: codexPtyOnAlternateScreen(),
      agent: 'codex'
    })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 10_000 }))

    // The tail carries a shell line and the agent reports working, so the tail-only lanes
    // cannot settle this wait. Before the fix the probe was gated to AGY and an empty tail,
    // so nothing ever asked the provider for the screen it was already painting.
    expect(startVisibleReadProbe).toHaveBeenCalledTimes(1)
    expect(startVisibleReadProbe.mock.calls[0]?.[2]).toBe('codex')
    expect(settled).not.toHaveBeenCalled()
  })

  it('keeps asking while the screen has not painted, so a slow first paint still settles', async () => {
    const { wait, startVisibleReadProbe } = createWait({
      pty: codexPtyOnAlternateScreen(),
      agent: 'codex'
    })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 10_000 }))

    // A launch registers the waiter while the TUI is still drawing. One bounded look at a
    // blank screen would hand the wait back to the tail-only sweep, which cannot see the
    // banner at all, so the probe has to come back on its own cadence.
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS * 3)
    expect(startVisibleReadProbe.mock.calls.length).toBeGreaterThan(1)
    expect(settled).not.toHaveBeenCalled()
  })

  it('retires the repeating probe when the waiter times out, leaving no timer behind', async () => {
    const { wait, startVisibleReadProbe } = createWait({
      pty: codexPtyOnAlternateScreen(),
      agent: 'codex'
    })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 5_000 }))

    await vi.advanceTimersByTimeAsync(6_000)
    expect(settled).toHaveBeenCalledWith({ error: 'timeout' })
    const probesAtTimeout = startVisibleReadProbe.mock.calls.length
    // Why this matters: the repeat rides on the waiter, and the registry's single `remove`
    // path is the only thing that retires it. A probe still firing here would outlive its
    // waiter and keep reading a terminal nobody is waiting on.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(startVisibleReadProbe.mock.calls.length).toBe(probesAtTimeout)
  })

  it('leaves a pane that settles from its own tail alone', async () => {
    const { wait, startVisibleReadProbe } = createWait({
      pty: makeTuiIdlePty({
        lastAgentStatus: 'working',
        tailBuffer: ['Claude Code ready']
      }),
      agent: 'claude'
    })
    watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 5_000 }))

    // Why this case guards the fix: only the agents whose readiness the tail can never
    // carry may re-read the screen. Widening the gate past them would add a provider read
    // per waiting pane to lanes that already answer from the tail.
    expect(startVisibleReadProbe).not.toHaveBeenCalled()
  })

  it('still settles a codex pane from the tail without probing once the banner is in scrollback', async () => {
    const { wait, startVisibleReadProbe } = createWait({
      pty: makeTuiIdlePty({
        lastAgentStatus: 'working',
        tailBuffer: [
          'OpenAI Codex (v0.157.0)',
          'model:       GPT-6-Astra high',
          'directory:   /tmp/repo',
          '> Ask Codex to do anything'
        ]
      }),
      agent: 'codex'
    })

    await expect(
      wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 5_000 })
    ).resolves.toMatchObject({ satisfied: true })
    // A codex build that still writes the banner to scrollback is answered by the tail, so
    // it must not pay for a screen read on top of it.
    expect(startVisibleReadProbe).not.toHaveBeenCalled()
  })
})