import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './terminal-idle-polls'
import type { TerminalWaiter } from './terminal-waiter'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { RuntimeTerminalWait } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../../shared/agent-launch/catalog/tui-agent-config'

const INTERVAL_MS = 2000

function makePty(ptyId: string, overrides: Partial<RuntimePtyWorktreeRecord> = {}) {
  return {
    ptyId,
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastOutputAt: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  } as unknown as RuntimePtyWorktreeRecord
}

function makeWaiter(handle: string): TerminalWaiter {
  return {
    handle,
    ptyId: `${handle}-pty`,
    condition: 'tui-idle',
    resolve: () => {},
    reject: () => {},
    timeout: null,
    cancelIdlePoll: null,
    abortCleanup: null
  }
}

describe('RuntimeTerminalIdlePolls concurrent waits', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs the foreground read per waiter without one waiter blocking another', async () => {
    const resolved: string[] = []
    const gates = new Map<string, (value: string | null) => void>()
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: 1500,
      getForegroundProcess: (ptyId) =>
        new Promise<string | null>((resolve) => {
          gates.set(ptyId, resolve)
        }),
      hasCommandPainted: () => true,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null,
      readVisibleScreen: () => null,
      resolve: (waiter) => resolved.push(waiter.handle)
    })

    polls.start(makeWaiter('slow'), makePty('pty-slow', { lastOutputAt: Date.now() - 10_000 }))
    polls.start(makeWaiter('fast'), makePty('pty-fast', { lastOutputAt: Date.now() - 10_000 }))

    vi.advanceTimersByTime(INTERVAL_MS)
    gates.get('pty-fast')?.('node')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual(['fast'])

    gates.get('pty-slow')?.('node')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual(['fast', 'slow'])
  })
})

describe('RuntimeTerminalIdlePolls rendered-screen blocked prompts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const TRUST_SCREEN = [
    'Accessing workspace:',
    '/repo/app',
    'Quick safety check: Is this a project you created or one you trust?',
    '❯ No, exit',
    '  Yes, I trust this folder',
    'Enter to confirm · Esc to cancel'
  ].join('\n')

  function createPolls(
    readVisibleScreen: (ptyId: string) => Promise<string | null> | null,
    resolved: RuntimeTerminalWait[],
    foreground: string | null = 'claude',
    agent: TuiAgent | null = null
  ): RuntimeTerminalIdlePolls {
    return new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: 1500,
      // Unknown agent + quiet pane: without the screen check this would settle idle.
      getForegroundProcess: () => (foreground ? Promise.resolve(foreground) : null),
      hasCommandPainted: () => true,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => agent,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null,
      readVisibleScreen,
      resolve: (_waiter, result) => resolved.push(result)
    })
  }

  it('does not resolve a waiter that was cancelled while its screen read was pending', async () => {
    const resolved: RuntimeTerminalWait[] = []
    const finishRead = new Map<string, (screen: string) => void>()
    const polls = createPolls(
      (ptyId) => {
        return new Promise<string>((resolve) => {
          finishRead.set(ptyId, resolve)
        })
      },
      resolved,
      null
    )
    const waiter = makeWaiter('pty')
    polls.start(waiter, makePty('pty-1'))
    polls.start(makeWaiter('other'), makePty('pty-2'))

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    const completeCancelledRead = finishRead.get('pty-1')
    const completeLiveRead = finishRead.get('pty-2')
    if (!completeCancelledRead || !completeLiveRead) {
      throw new Error('Both screen reads must be pending before cancelling')
    }

    waiter.cancelIdlePoll?.()
    completeCancelledRead(TRUST_SCREEN)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual([])

    completeLiveRead(TRUST_SCREEN)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual([expect.objectContaining({ blockedReason: 'agent-trust-workspace' })])
  })
})

describe('RuntimeTerminalIdlePolls quiet foreground for a launched agent', () => {
  const QUIESCENCE_MS = 1500

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createPolls(agent: TuiAgent, resolved: string[]): RuntimeTerminalIdlePolls {
    return new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: QUIESCENCE_MS,
      getForegroundProcess: () => Promise.resolve(TUI_AGENT_CONFIG[agent].expectedProcess),
      hasCommandPainted: () => true,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => agent,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null,
      readVisibleScreen: () => null,
      resolve: (waiter) => resolved.push(waiter.handle)
    })
  }

  // Amp titles never classify; disabling this lane for launches caused 60s worker readiness failure (STA-7440).
  it('settles an agent with no other rest signal once it has painted and gone quiet', async () => {
    const resolved: string[] = []
    const polls = createPolls('amp', resolved)
    const pty = makePty('pty-amp')
    polls.start(makeWaiter('pty'), pty)

    // Booting: the agent owns the foreground but has painted nothing (#9976).
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5)
    expect(resolved).toEqual([])

    await vi.advanceTimersByTimeAsync(INTERVAL_MS / 2)
    pty.lastOutputAt = Date.now()
    // The next sweep lands inside the quiet window measured from that paint.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS / 2)
    expect(resolved).toEqual([])

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(resolved).toEqual(['pty'])
  })
})
