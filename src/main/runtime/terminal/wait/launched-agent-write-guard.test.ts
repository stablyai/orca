import { describe, expect, it, vi } from 'vitest'
import type { LaunchedAgentForeground } from './launched-agent-foreground'
import {
  createLaunchedAgentWriteGuard,
  type LaunchedAgentWriteGuardRuntime
} from './launched-agent-write-guard'

type GuardOptions = {
  unprovableHost?: 'refuse' | 'write-unless-shell' | 'write-if-shell-provable'
  agentForegroundWaitMs?: number
  agentForegroundDeadlineMs?: number
}

function guardHarness(foregrounds: LaunchedAgentForeground[], options?: GuardOptions) {
  const answers = [...foregrounds]
  let listener: ((data: string) => void) | null = null
  const unsubscribe = vi.fn(() => {
    listener = null
  })
  const runtime: LaunchedAgentWriteGuardRuntime = {
    readLaunchedAgentForeground: vi.fn(
      async (): Promise<LaunchedAgentForeground> => answers.shift() ?? 'agent'
    ),
    subscribeToTerminalData: vi.fn((_ptyId: string, next: (data: string) => void) => {
      listener = next
      return unsubscribe
    })
  }
  const guard = createLaunchedAgentWriteGuard(runtime, 'claude', options)
  return { runtime, guard, unsubscribe, emit: (data: string) => listener?.(data) }
}

describe('the check before each write of a launch prompt', () => {
  it('catches a shell that returns while the first read is still running', async () => {
    const { runtime, guard, emit } = guardHarness([])
    vi.mocked(runtime.readLaunchedAgentForeground)
      .mockImplementationOnce(async () => {
        emit('\x1b[?2004h')
        return 'agent'
      })
      .mockResolvedValueOnce('shell')

    await guard.beforeWrite('pty-1')

    await expect(guard.beforeWrite('pty-1')).rejects.toThrow('agent_not_in_foreground')
  })
})

describe('a fresh launch that outruns the agent foreground claim (#40253)', () => {
  it('waits for the agent to take the foreground before writing', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, guard } = guardHarness(['shell', 'unknown', 'agent'], {
        unprovableHost: 'write-unless-shell',
        agentForegroundWaitMs: 5_000
      })
      const write = guard.beforeWrite('pty-1')
      await vi.advanceTimersByTimeAsync(600)
      await expect(write).resolves.toBeUndefined()
      expect(runtime.readLaunchedAgentForeground).toHaveBeenCalledTimes(3)
      guard.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still refuses when the shell keeps the foreground through the wait', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, guard } = guardHarness(['shell', 'shell', 'shell', 'shell', 'shell'], {
        unprovableHost: 'write-unless-shell',
        agentForegroundWaitMs: 1_000
      })
      const write = guard.beforeWrite('pty-1')
      const refused = expect(write).rejects.toThrow('agent_not_in_foreground')
      await vi.advanceTimersByTimeAsync(1_200)
      await refused
      // The guard polled past its first read instead of refusing on it.
      expect(vi.mocked(runtime.readLaunchedAgentForeground).mock.calls.length).toBeGreaterThan(1)
      guard.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a read at or past the caller deadline', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, guard } = guardHarness(['shell', 'shell', 'shell', 'shell', 'shell'], {
        unprovableHost: 'write-unless-shell',
        agentForegroundWaitMs: 60_000,
        agentForegroundDeadlineMs: Date.now() + 1_000
      })
      const write = guard.beforeWrite('pty-1')
      const refused = expect(write).rejects.toThrow('agent_not_in_foreground')
      await vi.advanceTimersByTimeAsync(5_000)
      await refused
      // Reads at 0/250/500/750 ms only: the sleep stops at the deadline and no read follows it.
      expect(runtime.readLaunchedAgentForeground).toHaveBeenCalledTimes(4)
      guard.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not poll when the caller deadline is already spent', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, guard } = guardHarness(['shell', 'shell', 'shell'], {
        unprovableHost: 'write-unless-shell',
        agentForegroundWaitMs: 10_000,
        agentForegroundDeadlineMs: Date.now() - 5
      })
      const write = guard.beforeWrite('pty-1')
      const refused = expect(write).rejects.toThrow('agent_not_in_foreground')
      await vi.advanceTimersByTimeAsync(5_000)
      await refused
      // A hook consumed the readiness budget: the guard refuses on its single read.
      expect(runtime.readLaunchedAgentForeground).toHaveBeenCalledTimes(1)
      guard.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

it('invalidates reused and pending foreground proof when the terminal session is replaced', async () => {
  const { runtime, guard } = guardHarness(['agent', 'shell'])
  const first = { incarnationId: 'first' }
  const identity = vi.fn(() => first)
  const fenced = createLaunchedAgentWriteGuard(
    { ...runtime, launchedAgentTerminalIdentity: identity },
    'claude'
  )
  await fenced.beforeWrite('pty-1')
  first.incarnationId = 'replacement'
  await expect(fenced.beforeWrite('pty-1')).rejects.toThrow('agent_not_in_foreground')
  vi.mocked(runtime.readLaunchedAgentForeground).mockImplementationOnce(async () => {
    first.incarnationId = 'third'
    return 'agent'
  })
  await expect(fenced.beforeWrite('pty-1')).rejects.toThrow('request_aborted')
  guard.dispose()
  fenced.dispose()
})
