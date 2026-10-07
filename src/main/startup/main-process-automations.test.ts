import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRunTerminalObserver } from '../automations/run-completion-watcher'
import { initializeMainProcessAutomations } from './main-process-automations'

type Request = {
  automation: {
    workspaceMode: string
    workspaceId: string | null
    reuseSession: boolean
    agentId: string
    prompt: string
  }
  run: { title: string }
  target: { repo: object }
}
type Options = {
  terminalObserver: AutomationRunTerminalObserver
  headlessDispatcher: (request: Request) => Promise<{
    terminalPaneKey: string | null
    completion?: Promise<unknown>
  }>
}
const fixture = vi.hoisted(() => ({
  options: ((): Options | null => null)(),
  runtime: {
    launchAgentTerminal: vi.fn(),
    createManagedWorktree: vi.fn(),
    showManagedWorktree: vi.fn(),
    waitForTerminal: vi.fn(),
    readTerminal: vi.fn(),
    getTerminalHandleForPaneKey: vi.fn(),
    notifyAutomationsChanged: vi.fn(),
    setAutomationService: vi.fn()
  }
}))
vi.mock('../automations/service', () => ({
  AutomationService: class {
    constructor(_store: object, options: Options) {
      fixture.options = options
    }
  }
}))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    store: {},
    runtime: fixture.runtime,
    claudeUsage: {},
    codexUsage: {},
    isServeMode: true
  }
}))
vi.mock('../automations/headless-workspace-create', () => ({
  buildHeadlessAutomationWorktreeCreateArgs: () => ({})
}))

function request(reuseSession = false, workspaceMode = 'existing'): Request {
  return {
    automation: {
      workspaceMode,
      workspaceId: 'workspace',
      reuseSession,
      agentId: 'codex',
      prompt: 'tick'
    },
    run: { title: 'tick' },
    target: { repo: {} }
  }
}
function options(): Options {
  initializeMainProcessAutomations()
  if (!fixture.options) {
    throw new Error('Missing automation options')
  }
  return fixture.options
}

describe('headless automation observation wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    fixture.runtime.waitForTerminal.mockResolvedValue({ satisfied: true })
    fixture.runtime.launchAgentTerminal.mockResolvedValue({
      handle: 'terminal',
      tabId: 'tab',
      paneKey: 'pane',
      ptyId: 'pty',
      worktreeId: 'workspace'
    })
    fixture.runtime.showManagedWorktree.mockResolvedValue({ displayName: 'workspace' })
    fixture.runtime.readTerminal.mockResolvedValue({ tail: ['actual finished turn'] })
  })
  afterEach(() => vi.useRealTimers())

  it('uses the shared observer rather than a single wait completion override', async () => {
    const opts = options()
    const launch = await opts.headlessDispatcher(request())
    expect(launch.terminalPaneKey).toBe('pane')
    expect(launch.completion).toBeUndefined()
    expect(fixture.runtime.waitForTerminal).not.toHaveBeenCalled()
    fixture.runtime.waitForTerminal
      .mockRejectedValueOnce(new Error('timeout')) // Initial busy probe.
      .mockRejectedValueOnce(new Error('timeout')) // One expired observation interval.
      .mockResolvedValueOnce({ satisfied: true })
    const observed = await opts.terminalObserver.observeCompletion('terminal', {
      signal: new AbortController().signal
    })
    expect(observed.status).toBe('completed')
    expect(observed.outputSnapshot?.content).toBe('actual finished turn')
    expect(fixture.runtime.waitForTerminal).toHaveBeenCalledTimes(3)
  })

  it('does not call a previous idle state completion for a new turn', async () => {
    const opts = options()
    await opts.headlessDispatcher(request())
    fixture.runtime.waitForTerminal.mockResolvedValue({ satisfied: true })
    const observation = opts.terminalObserver.observeCompletion('terminal', {
      signal: new AbortController().signal
    })
    let settled = false
    void observation.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false)
    fixture.runtime.waitForTerminal.mockRejectedValueOnce(new Error('timeout'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await observation).status).toBe('completed')
  })

  it('refuses unsupported reuse before creating any terminal or worktree', async () => {
    const opts = options()
    for (const mode of ['existing', 'new_per_run']) {
      await expect(opts.headlessDispatcher(request(true, mode))).rejects.toThrow(
        'Headless automations do not support session reuse. No terminal was launched.'
      )
    }
    expect(fixture.runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(fixture.runtime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('preserves a real blocked result without calling it complete', async () => {
    const opts = options()
    await opts.headlessDispatcher(request())
    fixture.runtime.waitForTerminal.mockResolvedValue({
      satisfied: false,
      blockedReason: 'permission'
    })
    const observed = await opts.terminalObserver.observeCompletion('terminal', {
      signal: new AbortController().signal
    })
    expect(observed.status).toBe('dispatch_failed')
    expect(observed.error).toContain('permission')
  })
})
