import { describe, expect, it, vi } from 'vitest'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { AutomationRunTerminalObserver } from './run-completion-watcher'

type CapturedServiceOptions = {
  headlessDispatcher?: HeadlessAutomationDispatcher
  terminalObserver?: AutomationRunTerminalObserver
}

const captured = vi.hoisted((): { options: CapturedServiceOptions } => ({ options: {} }))

const { deliverTerminalAgentLaunchPrompt } = vi.hoisted(() => ({
  deliverTerminalAgentLaunchPrompt: vi.fn(async () => true)
}))
vi.mock('../runtime/rpc/methods/agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt
}))

vi.mock('./service', () => ({
  AutomationService: class {
    start(): void {}
    stop(): void {}
    constructor(_store: unknown, opts: CapturedServiceOptions) {
      captured.options = opts
    }
  }
}))

import { createRuntimeAutomationService } from './runtime-automation-service'

function capturedOption<K extends keyof CapturedServiceOptions>(
  key: K
): NonNullable<CapturedServiceOptions[K]> {
  const value = captured.options[key]
  if (value === undefined) {
    throw new Error(`the service was constructed without ${key}`)
  }
  return value
}

describe('headless automation dispatch', () => {
  it('hands the launched run to its watcher instead of awaiting one tui-idle wait itself', async () => {
    const runtime = {
      setAutomationService: vi.fn(),
      notifyAutomationsChanged: vi.fn(),
      launchAgentTerminal: vi.fn(async () => ({
        handle: 'terminal-1',
        tabId: 'tab-1',
        paneKey: 'tab-1:pane-1',
        ptyId: 'pty-1',
        worktreeId: 'wt-1'
      })),
      showManagedWorktree: vi.fn(async () => ({ displayName: 'repo' })),
      waitForTerminal: vi.fn(),
      getTerminalHandleForPaneKey: vi.fn(() => null),
      getAgentStatusRowsForPane: vi.fn(() => [])
    }
    createRuntimeAutomationService({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service never reads the store; the dispatcher reads only past runs.
      store: { listAutomationRuns: () => [] } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only the members faked above.
      runtime: runtime as never,
      headless: true
    })
    const dispatcher = capturedOption('headlessDispatcher')
    const launch = await dispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a reuse-workspace automation; only these fields are read.
      automation: {
        workspaceMode: 'existing',
        workspaceId: 'wt-1',
        agentId: 'goose'
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the title and trigger are read.
      run: { title: 'Nightly', trigger: 'scheduled' } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unused for an existing workspace.
      target: {} as never
    })

    expect(launch.completion).toBeUndefined()
    expect(launch.terminalPaneKey).toBe('tab-1:pane-1')
    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith('id:wt-1', {
      agent: 'goose',
      prompt: '',
      title: 'Nightly',
      suppressStartupUpdatePrompt: true
    })
    expect(runtime.waitForTerminal).not.toHaveBeenCalled()
    const observer = capturedOption('terminalObserver')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution reads only the pane key.
    expect(observer.resolveRunTerminal({ terminalPaneKey: 'tab-1:pane-1' } as never)).toBe(
      'terminal-1'
    )
  })
})
