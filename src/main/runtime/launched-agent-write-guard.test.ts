import { describe, expect, it, vi } from 'vitest'
import type { LaunchedAgentForeground } from './launched-agent-foreground'
import {
  createLaunchedAgentWriteGuard,
  type LaunchedAgentWriteGuardRuntime
} from './launched-agent-write-guard'

function guardHarness(foregrounds: LaunchedAgentForeground[]) {
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
  const guard = createLaunchedAgentWriteGuard(runtime, 'claude')
  return { runtime, guard, unsubscribe, emit: (data: string) => listener?.(data) }
}

describe('the check before each write of a launch prompt', () => {
  it('reuses a read that found the agent for the writes after it', async () => {
    const { runtime, guard } = guardHarness(['agent'])

    await guard.beforeWrite('pty-1')
    // The agent's own output after the paste says nothing about a shell.
    await guard.beforeWrite('pty-1')
    await guard.beforeWrite('pty-1')

    expect(runtime.readLaunchedAgentForeground).toHaveBeenCalledTimes(1)
  })

  // Why: a ready signal can come from a shell whose agent exited, so only a read that finds the
  // agent may let the text through; an unanswered read is not that.
  it.each(['shell', 'unknown'] as const)(
    'refuses a write when the read finds %s',
    async (found) => {
      const { guard, unsubscribe } = guardHarness([found])

      await expect(guard.beforeWrite('pty-1')).rejects.toThrow('agent_not_in_foreground')
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ['a shell turning bracketed paste on', '$ \x1b[?2004h'],
    ['a shell integration prompt mark', '\x1b]133;D;1\x07\x1b]133;A\x07$ '],
    ['a mark split across two chunks', ['\x1b[?20', '04h']]
  ] as const)('reads again after %s, and refuses a shell', async (_label, output) => {
    const { runtime, guard, emit } = guardHarness(['agent', 'shell'])

    await guard.beforeWrite('pty-1')
    for (const chunk of typeof output === 'string' ? [output] : output) {
      emit(chunk)
    }

    await expect(guard.beforeWrite('pty-1')).rejects.toThrow('agent_not_in_foreground')
    expect(runtime.readLaunchedAgentForeground).toHaveBeenCalledTimes(2)
  })

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

  it('stops watching when it refuses and when it is disposed', async () => {
    const refused = guardHarness(['shell'])
    await expect(refused.guard.beforeWrite('pty-1')).rejects.toThrow('agent_not_in_foreground')
    expect(refused.unsubscribe).toHaveBeenCalledTimes(1)

    const cleared = guardHarness(['agent'])
    await cleared.guard.beforeWrite('pty-1')
    cleared.guard.dispose()
    expect(cleared.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
