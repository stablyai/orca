import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { RuntimeTerminalIdlePolls } from './terminal-idle-polls'
import type { TerminalWaiter } from './terminal-waiter'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})

afterEach(() => vi.useRealTimers())

function terminal(): RuntimePtyWorktreeRecord {
  return {
    ptyId: 'pty-1',
    incarnationId: null,
    worktreeId: 'worktree-1',
    connectionId: null,
    runtimeSessionOwned: false,
    isWsl: null,
    wslDistro: null,
    launchConfig: null,
    launchToken: null,
    launchIncarnationId: null,
    launchAgent: null,
    launchCommandAgent: null,
    agentSessionOwners: [],
    foregroundAgent: null,
    connected: true,
    disconnectedAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastAgentStatusStartedAtEpochMs: null,
    lastAgentStatusRichInvalidatedAtEpochMs: null,
    lastOscTitle: null,
    lastOscTitleAt: null,
    lastOscTitleEpochMs: null,
    managementTitle: null,
    managementTitleAt: null,
    controllerTitle: null,
    title: null,
    titleUpdatedAt: null,
    lastOutputAt: 1_000,
    tailBuffer: [],
    tailTranscriptBuffer: [],
    tailTranscriptChars: 0,
    tailPartialLine: '',
    tailPendingAnsi: '',
    tailRedrawCursor: null,
    tailTruncated: false,
    tailLinesTotal: 0,
    preview: '',
    waitBlockedAt: null
  }
}

function waitFor(pty: RuntimePtyWorktreeRecord, results: RuntimeTerminalWait[]): TerminalWaiter {
  return {
    handle: 'term-1',
    ptyId: pty.ptyId,
    condition: 'tui-idle',
    resolve: (result) => results.push(result),
    reject: (error) => {
      throw error
    },
    timeout: null,
    cancelIdlePoll: null,
    abortCleanup: null
  }
}

function polls(
  readVisibleScreen: () => Promise<string | null> | null,
  getForegroundProcess: () => Promise<string | null> | null = () => null
): RuntimeTerminalIdlePolls {
  return new RuntimeTerminalIdlePolls({
    intervalMs: 1_000,
    quiescenceMs: 100,
    getAdoptedPtyIdleStatus: () => null,
    getPaneAgent: () => null,
    getFirstPartyAgentStatus: () => null,
    readScreenLines: () => null,
    hasCommandPainted: () => true,
    readVisibleScreen,
    getForegroundProcess,
    resolve: (waiter, result) => waiter.resolve(result)
  })
}

it('keeps input waiting when the agent becomes working during a screen read', async () => {
  const pty = terminal()
  const results: RuntimeTerminalWait[] = []
  const screen = Promise.withResolvers<string | null>()
  const waiter = waitFor(pty, results)
  try {
    polls(() => screen.promise).start(waiter, pty, { kind: 'ready-weak' })
    pty.lastAgentStatus = 'working'
    screen.resolve('')
    await vi.advanceTimersByTimeAsync(0)
    expect(results).toEqual([])

    pty.lastAgentStatus = 'idle'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(results).toEqual([
      {
        handle: 'term-1',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      }
    ])
  } finally {
    waiter.cancelIdlePoll?.()
  }
})

it('does not let an old foreground read settle an agent that has started working', async () => {
  const pty = terminal()
  pty.lastAgentStatus = null
  const results: RuntimeTerminalWait[] = []
  const foreground = Promise.withResolvers<string | null>()
  const waiter = waitFor(pty, results)
  try {
    polls(
      () => null,
      () => foreground.promise
    ).start(waiter, pty)
    await vi.advanceTimersByTimeAsync(1_000)
    pty.lastAgentStatus = 'working'
    foreground.resolve('codex')
    await vi.advanceTimersByTimeAsync(0)
    expect(results).toEqual([])

    pty.lastAgentStatus = 'idle'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(results).toEqual([
      {
        handle: 'term-1',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      }
    ])
  } finally {
    waiter.cancelIdlePoll?.()
  }
})
