import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import { FOREGROUND_COMMAND_READS } from '../../shared/foreground-command-settle'
import { OpenCodeRunLifetimeStatus } from './opencode-run-lifetime-status'
import { CommandForegroundTracker } from '../../shared/command-foreground-tracker'

type Published = { ptyId: string; payload: ParsedAgentStatusPayload; yieldsToHookSince: number }

function setup(
  options: {
    name?: string | null
    commandLine?: string | null
    observable?: boolean
    enabledAgents?: readonly string[]
  } = {}
) {
  const published: Published[] = []
  const readForegroundProcessName = vi.fn(async (_ptyId: string): Promise<string | null> =>
    options.name === undefined ? 'opencode' : options.name
  )
  const readForegroundCommandLine = vi.fn(async () =>
    options.commandLine === undefined ? 'opencode run fix the bug' : options.commandLine
  )
  let clock = 1_000
  const status = new OpenCodeRunLifetimeStatus({
    isStatusEnabled: (agent) =>
      (options.enabledAgents ?? ['opencode', 'opencode2']).includes(agent),
    readForegroundCommandLine,
    publish: (ptyId, payload, yieldsToHookSince) =>
      published.push({ ptyId, payload, yieldsToHookSince }),
    now: () => clock++
  })
  // Wired as the runtime wires them: the tracker reads, the run producer consumes its samples.
  const observable = options.observable ?? true
  const tracker = new CommandForegroundTracker({
    read: async (ptyId) =>
      observable
        ? { available: true, process: await readForegroundProcessName(ptyId) }
        : { available: false, process: null },
    readsOnStart: () => observable && status.wantsStartReads(),
    onSample: (ptyId, process, commandId) => status.observeForeground(ptyId, process, commandId),
    now: () => 0
  })
  const lifetime = {
    onCommandStarted: (ptyId: string) => status.onCommandStarted(ptyId, tracker.started(ptyId)),
    onCommandFinished: (ptyId: string, exitCode: number | null) => {
      tracker.forget(ptyId)
      status.onCommandFinished(ptyId, exitCode)
    },
    forgetPty: (ptyId: string) => {
      tracker.forget(ptyId)
      status.forgetPty(ptyId)
    }
  }
  const states = (): string[] =>
    published.map(({ payload }) =>
      payload.interrupted ? `${payload.state}:interrupted` : payload.state
    )
  return { lifetime, published, states, readForegroundProcessName, readForegroundCommandLine }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.settleMs)
}

describe('OpenCodeRunLifetimeStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows Working while `opencode run` holds the foreground and Done when it exits', async () => {
    const { lifetime, published, states } = setup()
    lifetime.onCommandStarted('pty-1')
    expect(states()).toEqual([])
    await settle()
    expect(states()).toEqual(['working'])
    lifetime.onCommandFinished('pty-1', 0)
    expect(states()).toEqual(['working', 'done'])
    expect(published.map((entry) => entry.ptyId)).toEqual(['pty-1', 'pty-1'])
    expect(published.map((entry) => entry.payload.agentType)).toEqual(['opencode', 'opencode'])
    // Both writes yield to a hook that reports after this command started.
    expect(new Set(published.map((entry) => entry.yieldsToHookSince))).toEqual(new Set([1_000]))
  })

  it('reports `opencode2 run` as OpenCode 2', async () => {
    const { lifetime, published } = setup({
      name: 'opencode2',
      commandLine: '/usr/local/bin/opencode2 run --model a/b hi'
    })
    lifetime.onCommandStarted('pty-1')
    await settle()
    expect(published[0]?.payload.agentType).toBe('opencode2')
  })

  it('marks a Ctrl-C exit as interrupted and any other exit as a plain Done', async () => {
    const { lifetime, states } = setup()
    lifetime.onCommandStarted('pty-1')
    await settle()
    lifetime.onCommandFinished('pty-1', 130)
    lifetime.onCommandStarted('pty-1')
    await settle()
    lifetime.onCommandFinished('pty-1', 1)
    expect(states()).toEqual(['working', 'done:interrupted', 'working', 'done'])
  })

  it('reads no argv unless the foreground process is OpenCode', async () => {
    const { lifetime, states, readForegroundCommandLine } = setup({ name: 'npm' })
    lifetime.onCommandStarted('pty-1')
    await settle()
    lifetime.onCommandFinished('pty-1', 0)
    expect(readForegroundCommandLine).not.toHaveBeenCalled()
    expect(states()).toEqual([])
  })

  it.each(['zsh', 'npx', '/usr/local/bin/node', 'bun.exe'])(
    're-reads on the shared ladder while the foreground is %s, until OpenCode execs',
    async (firstName) => {
      const { lifetime, states, readForegroundProcessName } = setup()
      readForegroundProcessName.mockResolvedValueOnce(firstName)
      lifetime.onCommandStarted('pty-1')
      await settle()
      expect(states()).toEqual([])
      await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_READS.retryDelaysMs[0])
      expect(states()).toEqual(['working'])
      expect(readForegroundProcessName).toHaveBeenCalledTimes(2)
    }
  )

  it('stops re-reading after the last rung for a shell or launcher that never becomes OpenCode', async () => {
    for (const name of ['node', 'bash']) {
      const { lifetime, readForegroundProcessName } = setup({ name })
      lifetime.onCommandStarted('pty-1')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(readForegroundProcessName).toHaveBeenCalledTimes(
        1 + FOREGROUND_COMMAND_READS.retryDelaysMs.length
      )
    }
  })

  // Why: another agent, an editor or a dev server never execs OpenCode as the pane's foreground.
  it.each(['claude', 'codex', 'vim', 'sleep', 'python3'])(
    'reads %s once and stops',
    async (name) => {
      const { lifetime, states, readForegroundProcessName } = setup({ name })
      lifetime.onCommandStarted('pty-1')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(readForegroundProcessName).toHaveBeenCalledTimes(1)
      expect(states()).toEqual([])
    }
  )

  it('leaves the OpenCode TUI and its other subcommands to their own reporters', async () => {
    for (const commandLine of ['opencode', 'opencode serve', 'opencode attach http://x', null]) {
      const { lifetime, states } = setup({ commandLine })
      lifetime.onCommandStarted('pty-1')
      await settle()
      lifetime.onCommandFinished('pty-1', 0)
      expect(states()).toEqual([])
    }
  })

  it('ignores a command line whose agent is not the foreground name', async () => {
    const { lifetime, states } = setup({ name: 'opencode2', commandLine: 'opencode run hi' })
    lifetime.onCommandStarted('pty-1')
    await settle()
    expect(states()).toEqual([])
  })

  it('stays silent for a command that finishes before the settle read (`&`, fast exit)', async () => {
    const { lifetime, states, readForegroundProcessName } = setup()
    lifetime.onCommandStarted('pty-1')
    lifetime.onCommandFinished('pty-1', 0)
    await settle()
    expect(readForegroundProcessName).not.toHaveBeenCalled()
    expect(states()).toEqual([])
  })

  it('never arms from a read that a newer command superseded', async () => {
    let resolveName: (name: string) => void = () => {}
    const { lifetime, states, readForegroundProcessName } = setup()
    readForegroundProcessName.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveName = resolve
        })
    )
    lifetime.onCommandStarted('pty-1')
    await settle()
    lifetime.onCommandFinished('pty-1', 0)
    resolveName('opencode')
    await vi.runAllTimersAsync()
    expect(states()).toEqual([])
  })

  it('stays silent when OpenCode status is turned off for that agent', async () => {
    const { lifetime, states, readForegroundCommandLine } = setup({ enabledAgents: ['opencode2'] })
    lifetime.onCommandStarted('pty-1')
    await settle()
    lifetime.onCommandFinished('pty-1', 0)
    expect(readForegroundCommandLine).not.toHaveBeenCalled()
    expect(states()).toEqual([])
  })

  it('sets no timer and reads nothing while status is off for both OpenCode agents', () => {
    const { lifetime, readForegroundProcessName } = setup({ enabledAgents: [] })
    lifetime.onCommandStarted('pty-1')
    expect(vi.getTimerCount()).toBe(0)
    expect(readForegroundProcessName).not.toHaveBeenCalled()
  })

  it('reads nothing for a pane whose foreground is on another host', async () => {
    const { lifetime, states, readForegroundProcessName } = setup({ observable: false })
    lifetime.onCommandStarted('pty-1')
    await settle()
    lifetime.onCommandFinished('pty-1', 0)
    expect(readForegroundProcessName).not.toHaveBeenCalled()
    expect(states()).toEqual([])
  })

  it('ends an armed run with Done when the next command starts without its 133;D', async () => {
    const { lifetime, states } = setup()
    lifetime.onCommandStarted('pty-1')
    await settle()
    lifetime.onCommandStarted('pty-1')
    expect(states()).toEqual(['working', 'done'])
    await settle()
    expect(states()).toEqual(['working', 'done', 'working'])
  })

  it('posts no Done for a pane torn down mid-run', async () => {
    const { lifetime, states } = setup()
    lifetime.onCommandStarted('pty-1')
    await settle()
    lifetime.forgetPty('pty-1')
    lifetime.onCommandFinished('pty-1', 0)
    expect(states()).toEqual(['working'])
  })

  it('keeps each pane to its own command', async () => {
    const { lifetime, published } = setup()
    lifetime.onCommandStarted('pty-1')
    lifetime.onCommandStarted('pty-2')
    await settle()
    lifetime.onCommandFinished('pty-2', 0)
    expect(published.map((entry) => `${entry.ptyId}:${entry.payload.state}`)).toEqual([
      'pty-1:working',
      'pty-2:working',
      'pty-2:done'
    ])
  })
})
