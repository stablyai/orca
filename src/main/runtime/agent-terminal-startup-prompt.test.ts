/**
 * The launch command a terminal create builds when the launch hands it a prompt.
 *
 * This is the argv half of terminal prompt delivery, and the reason it is worth pinning is that
 * its failure mode is silent: `buildAgentStartupPlan` answers a prompt it cannot fold by returning
 * a bare command plus a `followupPrompt`, and this resolver returns options, not a live PTY, so a
 * dropped `followupPrompt` would spawn the agent with no prompt and no error anywhere.
 */

import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// The shell the host names for a local line; bash takes no multi-line line, zsh does.
function runtimeWithAgentLaunch(
  options: { terminalDefaultShell?: string; connectionId?: string } = {}
): {
  runtime: OrcaRuntimeService
  spawn: ReturnType<typeof vi.fn>
} {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver under test is a protected member; the assertion names only the two internals this stub replaces, each of which is assigned before the create reaches it.
  const internal = runtime as unknown as {
    store: { getSettings: () => Record<string, unknown> }
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  internal.store = {
    getSettings: () => ({ terminalDefaultShell: options.terminalDefaultShell ?? '/bin/bash' })
  }
  vi.spyOn(internal, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-1',
    path: '/repo/app',
    connectionId: options.connectionId ?? null,
    repo: null,
    folderWorkspace: null
  })
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

/** The command the PTY was actually spawned with, or '' when nothing was spawned. */
function spawnedCommand(spawn: ReturnType<typeof vi.fn>): string {
  const command = spawn.mock.calls[0]?.[0]?.command
  return typeof command === 'string' ? command : ''
}

describe('a terminal create that is handed a launch prompt', () => {
  it.each([undefined, 'ssh-host'])(
    'captures host launch arguments for local and SSH terminals (%s)',
    async (connectionId) => {
      const { runtime, spawn } = runtimeWithAgentLaunch({ connectionId })
      const terminal = await runtime.createTerminal('id:wt-1', {
        startupAgent: 'claude',
        agentArgs: '--model opus --effort high',
        startupPrompt: 'private prompt'
      })
      const snapshot = terminal.launchSnapshot
      expect(snapshot).toEqual({
        agentId: 'claude',
        effectiveAgentArgs: '--model opus --effort high'
      })
      expect(spawnedCommand(spawn)).toContain('--model')
      expect(snapshot?.effectiveAgentArgs).not.toContain('private prompt')
    }
  )

  it('does not report retry arguments as launch facts for a reattached process', async () => {
    const { runtime, spawn } = runtimeWithAgentLaunch()
    spawn.mockResolvedValue({ id: 'pty-1', isReattach: true })
    const terminal = await runtime.createTerminal('id:wt-1', {
      startupAgent: 'claude',
      agentArgs: '--model opus'
    })
    expect(terminal.launchSnapshot).toBeUndefined()
  })

  it('folds an argv agent’s prompt into the command it spawns, and says it did', async () => {
    const { runtime, spawn } = runtimeWithAgentLaunch()
    const onStartupPromptCarry = vi.fn()

    await runtime.createTerminal('id:wt-1', {
      startupAgent: 'claude',
      startupPrompt: 'summarize the diff',
      onStartupPromptCarry
    })

    expect(spawnedCommand(spawn)).toContain('summarize the diff')
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ launchAgent: 'claude' }))
    expect(onStartupPromptCarry).toHaveBeenCalledWith(true)
  })

  it('starts clean, and says so, when the typed line cannot carry a multi-line prompt', async () => {
    const { runtime, spawn } = runtimeWithAgentLaunch()
    const onStartupPromptCarry = vi.fn()

    await runtime.createTerminal('id:wt-1', {
      startupAgent: 'claude',
      startupPrompt: 'summarize the diff\nthen list the risks',
      onStartupPromptCarry
    })

    // Typed into a shell, each newline would be Enter; the caller pastes it once the agent is up.
    expect(spawnedCommand(spawn)).toContain('claude')
    expect(spawnedCommand(spawn)).not.toContain('summarize')
    expect(onStartupPromptCarry).toHaveBeenCalledWith(false)
  })

  it('carries a short-lined multi-line prompt on a local zsh line, so the agent starts with it', async () => {
    const { runtime, spawn } = runtimeWithAgentLaunch({ terminalDefaultShell: '/bin/zsh' })
    const onStartupPromptCarry = vi.fn()

    await runtime.createTerminal('id:wt-1', {
      startupAgent: 'claude',
      startupPrompt: 'summarize the diff\nthen list the risks',
      onStartupPromptCarry
    })

    expect(spawnedCommand(spawn)).toContain('summarize the diff\nthen list the risks')
    expect(onStartupPromptCarry).toHaveBeenCalledWith(true)
  })

  it('starts clean on a remote host, whose shell this host cannot name', async () => {
    const { runtime, spawn } = runtimeWithAgentLaunch({
      terminalDefaultShell: '/bin/zsh',
      connectionId: 'ssh-1'
    })
    const onStartupPromptCarry = vi.fn()

    await runtime.createTerminal('id:wt-1', {
      startupAgent: 'claude',
      startupPrompt: 'summarize the diff\nthen list the risks',
      onStartupPromptCarry
    })

    expect(spawnedCommand(spawn)).not.toContain('summarize')
    expect(onStartupPromptCarry).toHaveBeenCalledWith(false)
  })

  it('starts Hermes clean instead of refusing when its env budget cannot hold the prompt', async () => {
    const { runtime, spawn } = runtimeWithAgentLaunch()
    const onStartupPromptCarry = vi.fn()

    await runtime.createTerminal('id:wt-1', {
      startupAgent: 'hermes',
      startupPrompt: 'x'.repeat(30_000),
      onStartupPromptCarry
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(onStartupPromptCarry).toHaveBeenCalledWith(false)
  })

  it('still builds a bare agent launch when no prompt is handed to it', async () => {
    const { runtime, spawn } = runtimeWithAgentLaunch()

    await runtime.createTerminal('id:wt-1', { startupAgent: 'claude' })

    expect(spawnedCommand(spawn)).toContain('claude')
    expect(spawnedCommand(spawn)).not.toContain('summarize')
  })

  it('refuses a prompt the launch command cannot carry instead of dropping it', async () => {
    const { runtime, spawn } = runtimeWithAgentLaunch()

    // `aider` takes its prompt after start, so there is no argument to fold it into and this
    // resolver has no PTY to write to. Spawning anyway would lose the text with no error.
    await expect(
      runtime.createTerminal('id:wt-1', {
        startupAgent: 'aider',
        startupPrompt: 'summarize the diff'
      })
    ).rejects.toThrow(/does not take a startup prompt/)
    expect(spawn).not.toHaveBeenCalled()
  })
})
