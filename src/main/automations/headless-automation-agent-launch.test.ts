import { describe, expect, it, vi } from 'vitest'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'

const CHAT_DEFAULT_ON = { experimentalNativeChat: true }

function harness(options: { startupTerminal?: Record<string, unknown> | null } = {}) {
  const runtime = {
    requireStore: () => ({ getSettings: () => CHAT_DEFAULT_ON }),
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true })),
    createManagedWorktree: vi.fn(async (_args: Record<string, unknown>) => ({
      worktree: { id: 'repo-1::/wt/auto', displayName: 'auto-nightly' },
      ...(options.startupTerminal === null
        ? { warning: 'Startup terminal failed.' }
        : {
            startupTerminal: options.startupTerminal ?? {
              handle: 'term_new',
              tabId: 'tab-new',
              paneKey: 'tab-new:leaf-1',
              ptyId: 'pty-new'
            }
          })
    })),
    launchAgentTerminal: vi.fn(async (_selector: string, _opts: Record<string, unknown>) => ({
      handle: 'term_existing',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      title: 'Nightly',
      suppressStartupUpdatePrompt: true
    })),
    showManagedWorktree: vi.fn(async () => ({ displayName: 'repo' })),
    getAgentStatusRowsForPane: vi.fn((_paneKey: string) => [
      { state: 'done', agentType: 'claude', receivedAt: 2 }
    ]),
    getTerminalHandleForPaneKey: vi.fn((paneKey: string) =>
      paneKey === 'tab-prev:leaf-1' ? 'term_prev' : null
    ),
    getTerminalPtyIdForHandle: vi.fn((_handle: string) => 'pty-prev'),
    deliverStartupFollowup: vi.fn(
      async (_handle: string, _followup: { agent: string; prompt: string }) => true
    )
  }
  return runtime
}

function automation(overrides: Record<string, unknown>) {
  return {
    id: 'auto-1',
    agentId: 'claude',
    prompt: '  fix the flaky test  ',
    workspaceMode: 'existing',
    workspaceId: 'wt-1',
    ...overrides
  }
}

const RUN = {
  id: 'run-1',
  title: 'Nightly',
  createdAt: Date.UTC(2026, 9, 9, 3),
  scheduledFor: Date.UTC(2026, 9, 9, 3),
  trigger: 'scheduled' as const
}
const TARGET = { ok: true, repo: { id: 'repo-1', path: '/repo', displayName: 'repo' } }

function launch(
  runtime: ReturnType<typeof harness>,
  overrides: Record<string, unknown>,
  runs: [] = [],
  run: typeof RUN | (Omit<typeof RUN, 'trigger'> & { trigger: 'manual' }) = RUN
) {
  return launchHeadlessAutomationAgent(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only the members faked in harness().
    runtime as never,
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read.
      automation: automation(overrides) as never,
      run,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the repo is read.
      target: TARGET as never,
      runs
    }
  )
}

describe('headless automation agent launch', () => {
  // E9: the runtime holds a background start on a stopped WSL distro; only Run now names the user.
  it("starts Run now as the user's act, and a scheduled run as background work", async () => {
    const scheduled = harness()
    await launch(scheduled, {})
    expect(scheduled.launchAgentTerminal.mock.calls[0]?.[1]).not.toHaveProperty('wslUserAct')

    const manual = harness()
    await launch(manual, {}, [], { ...RUN, trigger: 'manual' })
    expect(manual.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ wslUserAct: true })
    )
  })

  it('starts a post-start agent bare and delivers its prompt once, after the terminal is recorded', async () => {
    const runtime = harness()
    let finishDelivery: (delivered: boolean) => void = () => {}
    runtime.deliverStartupFollowup.mockImplementation(
      () => new Promise<boolean>((resolve) => (finishDelivery = resolve))
    )

    const launched = await launch(runtime, { agentId: 'aider' })

    expect(launched.terminalPaneKey).toBe('tab-1:leaf-1')
    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ agent: 'aider', prompt: '' })
    )
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledTimes(1)
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledWith('term_existing', {
      agent: 'aider',
      prompt: 'fix the flaky test'
    })
    finishDelivery(true)
  })

  it('fails the run with the create warning when no agent terminal started, without a second one', async () => {
    const runtime = harness({ startupTerminal: null })

    await expect(
      launch(runtime, { workspaceMode: 'new_per_run', workspaceId: null })
    ).rejects.toThrow('Startup terminal failed.')
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })

  it('logs a failure after the terminal was recorded instead of dropping it', async () => {
    const runtime = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtime.deliverStartupFollowup.mockRejectedValue(new Error('writer broke'))

    const launched = await launch(runtime, { agentId: 'aider' })
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('after its terminal was published'),
        expect.objectContaining({ message: 'writer broke' })
      )
    )

    expect(launched.terminalHandle).toBe('term_existing')
    warn.mockRestore()
  })

  it('refuses an existing-workspace run whose workspace is gone', async () => {
    const runtime = harness()

    await expect(launch(runtime, { workspaceId: null })).rejects.toThrow(
      'The target workspace is no longer available.'
    )
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })
})
