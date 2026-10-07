import { describe, expect, it, vi } from 'vitest'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { AutomationRunTerminalObserver } from './run-completion-watcher'

const captured = vi.hoisted((): { dispatcher: unknown; observer: unknown } => ({
  dispatcher: null,
  observer: null
}))

vi.mock('./service', () => ({
  AutomationService: class {
    start(): void {}
    stop(): void {}
    constructor(
      _store: unknown,
      opts: { headlessDispatcher?: unknown; terminalObserver?: unknown }
    ) {
      captured.dispatcher = opts.headlessDispatcher
      captured.observer = opts.terminalObserver
    }
  }
}))

import { createRuntimeAutomationService } from './runtime-automation-service'

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
      // Not resolvable by pane key yet: the launch's own handle must still reach the watcher.
      getTerminalHandleForPaneKey: vi.fn(() => null),
      getAgentStatusRowsForPane: vi.fn(() => [])
    }
    createRuntimeAutomationService({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service never reads the store.
      store: {} as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only the members faked above.
      runtime: runtime as never,
      headless: true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captured from the mocked constructor above.
    const dispatcher = captured.dispatcher as HeadlessAutomationDispatcher
    const launch = await dispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a reuse-workspace automation; only these fields are read.
      automation: { workspaceMode: 'existing', workspaceId: 'wt-1', agentId: 'goose' } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the title is read.
      run: { title: 'Nightly' } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unused for an existing workspace.
      target: {} as never
    })

    expect(launch.completion).toBeUndefined()
    expect(launch.terminalPaneKey).toBe('tab-1:pane-1')
    expect(runtime.waitForTerminal).not.toHaveBeenCalled()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captured from the mocked constructor above.
    const observer = captured.observer as AutomationRunTerminalObserver
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution reads only the pane key.
    expect(observer.resolveRunTerminal({ terminalPaneKey: 'tab-1:pane-1' } as never)).toBe(
      'terminal-1'
    )
  })
})
