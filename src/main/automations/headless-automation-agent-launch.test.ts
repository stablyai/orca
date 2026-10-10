import { describe, expect, it, vi } from 'vitest'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'

const CHAT_DEFAULT_ON = { experimentalNativeChat: true }

function harness(options: { startupTerminal?: Record<string, unknown> | null } = {}) {
  const runtime = {
    getClientSettings: () => CHAT_DEFAULT_ON,
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
      title: 'Nightly'
    })),
    showManagedWorktree: vi.fn(async () => ({ displayName: 'repo' })),
    deliverStartupFollowup: vi.fn(
      async (_handle: string, _followup: { expectedProcess: string; prompt: string }) => true
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

const RUN = { id: 'run-1', title: 'Nightly', scheduledFor: Date.UTC(2026, 9, 9, 3) }
const TARGET = { ok: true, repo: { id: 'repo-1', path: '/repo', displayName: 'repo' } }

function launch(runtime: ReturnType<typeof harness>, overrides: Record<string, unknown>) {
  return launchHeadlessAutomationAgent(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only the members faked in harness().
    runtime as never,
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read.
      automation: automation(overrides) as never,
      run: RUN,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the repo is read.
      target: TARGET as never
    }
  )
}

describe('headless automation agent launch', () => {
  it('starts an argv agent in an existing workspace with the prompt on its command', async () => {
    const runtime = harness()

    const launched = await launch(runtime, { extraAgentArgs: '--model opus' })

    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith('id:wt-1', {
      agent: 'claude',
      prompt: 'fix the flaky test',
      title: 'Nightly',
      extraAgentArgs: '--model opus'
    })
    expect(runtime.deliverStartupFollowup).not.toHaveBeenCalled()
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(launched).toEqual({
      workspaceId: 'wt-1',
      workspaceDisplayName: 'repo',
      terminalHandle: 'term_existing',
      terminalSessionId: 'tab-1',
      terminalPaneKey: 'tab-1:leaf-1',
      terminalPtyId: 'pty-1'
    })
  })

  it('starts a post-start agent bare and delivers its prompt once, after the terminal is recorded', async () => {
    const runtime = harness()
    let finishDelivery: (delivered: boolean) => void = () => {}
    runtime.deliverStartupFollowup.mockImplementation(
      () => new Promise<boolean>((resolve) => (finishDelivery = resolve))
    )

    const launched = await launch(runtime, { agentId: 'aider' })

    // The run is recorded while the agent is still coming up, as before.
    expect(launched.terminalPaneKey).toBe('tab-1:leaf-1')
    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ agent: 'aider', prompt: '' })
    )
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledTimes(1)
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledWith('term_existing', {
      agent: 'aider',
      expectedProcess: 'aider',
      prompt: 'fix the flaky test'
    })
    finishDelivery(true)
  })

  it('creates a new-per-run workspace agent-first with the argv prompt', async () => {
    const runtime = harness()

    const launched = await launch(runtime, {
      workspaceMode: 'new_per_run',
      workspaceId: null,
      extraAgentArgs: '--model opus'
    })

    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    const args = runtime.createManagedWorktree.mock.calls[0]![0]
    expect(args).toMatchObject({
      repoSelector: 'repo-1',
      activate: false,
      setupDecision: 'skip',
      startupAgent: 'claude',
      startupPrompt: 'fix the flaky test',
      startupExtraAgentArgs: '--model opus',
      createdWithAgent: 'claude',
      telemetrySource: 'unknown'
    })
    expect(args).not.toHaveProperty('awaitTerminalProvisioning')
    expect(args).not.toHaveProperty('observeSetupCompletion')
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(runtime.deliverStartupFollowup).not.toHaveBeenCalled()
    expect(launched).toEqual({
      workspaceId: 'repo-1::/wt/auto',
      workspaceDisplayName: 'auto-nightly',
      terminalHandle: 'term_new',
      terminalSessionId: 'tab-new',
      terminalPaneKey: 'tab-new:leaf-1',
      terminalPtyId: 'pty-new'
    })
  })

  it('creates a new-per-run workspace for a post-start agent and delivers its prompt once', async () => {
    const runtime = harness()

    await launch(runtime, { agentId: 'goose', workspaceMode: 'new_per_run', workspaceId: null })

    expect(runtime.createManagedWorktree.mock.calls[0]![0]).not.toHaveProperty('startupPrompt')
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledTimes(1)
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledWith('term_new', {
      agent: 'goose',
      expectedProcess: 'goose',
      prompt: 'fix the flaky test'
    })
  })

  it('fails the run with the create warning when no agent terminal started, without a second one', async () => {
    const runtime = harness({ startupTerminal: null })

    await expect(
      launch(runtime, { workspaceMode: 'new_per_run', workspaceId: null })
    ).rejects.toThrow('Startup terminal failed.')
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })

  it('launches bare and delivers nothing for a blank prompt', async () => {
    const runtime = harness()

    await launch(runtime, { agentId: 'aider', prompt: '   ' })

    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ prompt: '' })
    )
    expect(runtime.deliverStartupFollowup).not.toHaveBeenCalled()
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
