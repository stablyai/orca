import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../shared/automations-types'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'

const { deliverTerminalAgentLaunchPrompt } = vi.hoisted(() => ({
  deliverTerminalAgentLaunchPrompt: vi.fn(async (_args: Record<string, unknown>) => true)
}))
vi.mock('../runtime/rpc/methods/agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt
}))

beforeEach(() => {
  deliverTerminalAgentLaunchPrompt.mockClear()
  deliverTerminalAgentLaunchPrompt.mockResolvedValue(true)
})

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
      title: 'Nightly'
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

function previousRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-0',
    automationId: 'auto-1',
    title: 'Nightly',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: 'wt-1',
    workspaceDisplayName: 'repo',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-prev',
    terminalPaneKey: 'tab-prev:leaf-1',
    terminalPtyId: 'pty-prev',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

function launch(
  runtime: ReturnType<typeof harness>,
  overrides: Record<string, unknown>,
  runs: AutomationRun[] = []
) {
  return launchHeadlessAutomationAgent(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only the members faked in harness().
    runtime as never,
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read.
      automation: automation(overrides) as never,
      run: RUN,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the repo is read.
      target: TARGET as never,
      runs
    }
  )
}

describe('headless automation agent launch', () => {
  it('launches Hermes through the ordinary agent contract', async () => {
    const runtime = harness()

    const launched = await launch(runtime, { agentId: 'hermes' })

    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith('id:wt-1', {
      agent: 'hermes',
      prompt: 'fix the flaky test',
      title: 'Nightly'
    })
    expect(runtime.deliverStartupFollowup).not.toHaveBeenCalled()
    expect(launched.terminalHandle).toBe('term_existing')
  })

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

    expect(launched.terminalPaneKey).toBe('tab-1:leaf-1')
    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ agent: 'aider', prompt: '' })
    )
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledTimes(1)
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledWith('term_existing', {
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

  it('sends a reuse-session prompt into the idle agent its previous run left', async () => {
    const runtime = harness()

    const launched = await launch(runtime, { reuseSession: true }, [previousRun()])

    expect(deliverTerminalAgentLaunchPrompt).toHaveBeenCalledWith({
      runtime,
      handle: 'term_prev',
      agent: 'claude',
      freshLaunch: false,
      text: 'fix the flaky test',
      unprovableHost: 'write-unless-shell'
    })
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(launched).toEqual({
      workspaceId: 'wt-1',
      workspaceDisplayName: 'repo',
      terminalHandle: 'term_prev',
      terminalSessionId: 'tab-prev',
      terminalPaneKey: 'tab-prev:leaf-1',
      terminalPtyId: 'pty-prev'
    })
  })

  it('launches fresh when the idle agent did not take the prompt', async () => {
    const runtime = harness()
    deliverTerminalAgentLaunchPrompt.mockResolvedValue(false)

    const launched = await launch(runtime, { reuseSession: true }, [previousRun()])

    expect(deliverTerminalAgentLaunchPrompt).toHaveBeenCalledTimes(1)
    expect(runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
    expect(launched.terminalHandle).toBe('term_existing')
  })

  it.each([
    ['its pane now holds another PTY', { ptyId: 'pty-restarted' }],
    ['its agent is working', { row: { state: 'working', agentType: 'claude', receivedAt: 2 } }],
    ['another agent is in it', { row: { state: 'done', agentType: 'codex', receivedAt: 2 } }],
    ['the previous run did not complete', { run: { status: 'dispatch_failed' as const } }],
    ['reuse is off', { reuseSession: false }]
  ])('launches fresh without sending when %s', async (_label, setup) => {
    const runtime = harness()
    if ('ptyId' in setup) {
      runtime.getTerminalPtyIdForHandle.mockReturnValue(setup.ptyId)
    }
    if ('row' in setup) {
      runtime.getAgentStatusRowsForPane.mockReturnValue([setup.row])
    }

    await launch(runtime, { reuseSession: 'reuseSession' in setup ? setup.reuseSession : true }, [
      previousRun('run' in setup ? setup.run : {})
    ])

    expect(deliverTerminalAgentLaunchPrompt).not.toHaveBeenCalled()
    expect(runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
  })

  it('launches fresh while the previous run is still working in the reused agent', async () => {
    const runtime = harness()
    const inFlight = previousRun({ id: 'run-scheduled', status: 'dispatched', dispatchedAt: 2 })

    await launch(runtime, { reuseSession: true }, [previousRun(), inFlight])

    expect(deliverTerminalAgentLaunchPrompt).not.toHaveBeenCalled()
    expect(runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
  })

  it("reads the pane's newest status row, not a stale done", async () => {
    const runtime = harness()
    runtime.getAgentStatusRowsForPane.mockReturnValue([
      { state: 'done', agentType: 'claude', receivedAt: 1 },
      { state: 'working', agentType: 'claude', receivedAt: 3 }
    ])

    await launch(runtime, { reuseSession: true }, [previousRun()])

    expect(deliverTerminalAgentLaunchPrompt).not.toHaveBeenCalled()
  })
})
