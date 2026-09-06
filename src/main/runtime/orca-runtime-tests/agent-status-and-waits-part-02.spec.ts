import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  inspectPtyProviderProcess,
  makePaneKey
} from '../orca-runtime-test-mocks.spec'
import type { IPtyProvider } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  createExplicitAgentStatusHarness,
  deferred,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('prefers newer explicit working state over older explicit permission state', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const now = Date.now()
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'waiting',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now - 1000,
          stateStartedAt: now - 1000,
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        },
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: now,
          stateStartedAt: now,
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'working'
    })
  })

  it('prefers fresh explicit working state over a stale permission title', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex - action required',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'working'
    })
  })

  it('reports permission from a live title over fresh explicit working state', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'Codex - action required'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('does not let fresh explicit hook state authorize a current shell terminal', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'zsh',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('does not let fresh explicit hook state authorize a shell foreground process', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('uses strong provider confirmation to authorize fresh hook state over a shell foreground', async () => {
    const getForegroundProcess = vi.fn(async () => 'powershell.exe')
    const confirmForegroundProcess = vi.fn(async () => 'claude')
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: true,
      status: 'working'
    })
    expect(getForegroundProcess).toHaveBeenCalledOnce()
    expect(getForegroundProcess).toHaveBeenCalledWith('pty-1')
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
    expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-1')
  })

  it('preserves provider failure during completion-sensitive process inspection', async () => {
    const failure = new Error('daemon unavailable')
    const providerInspectProcess = vi.fn().mockRejectedValue(failure)
    const provider = { inspectProcess: providerInspectProcess } as unknown as IPtyProvider
    const inspectProcess = vi.fn((ptyId: string) => inspectPtyProviderProcess(provider, ptyId))
    const getForegroundProcess = vi.fn(async () => null)
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      inspectProcess
    })

    await expect(runtime.inspectTerminalProcess(handle)).rejects.toBe(failure)
    expect(inspectProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(providerInspectProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('preserves provider unavailable results during process inspection', async () => {
    const inspection = {
      foregroundProcess: null,
      hasChildProcesses: true,
      unavailable: true as const
    }
    const inspectProcess = vi.fn(async () => inspection)
    const getForegroundProcess = vi.fn(async () => null)
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      inspectProcess
    })

    await expect(runtime.inspectTerminalProcess(handle)).resolves.toEqual(inspection)
    expect(inspectProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('calls foreground confirmation with its controller receiver', async () => {
    const getForegroundProcess = vi.fn(async () => 'powershell.exe')
    const confirmForegroundProcess = vi.fn(
      async function (this: { getForegroundProcess: typeof getForegroundProcess }) {
        return this.getForegroundProcess === getForegroundProcess ? 'codex' : null
      }
    )
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
  })

  it.each([
    ['shell', async () => 'pwsh.exe'],
    ['non-agent', async () => 'vim'],
    ['unavailable', async () => null],
    [
      'failure',
      async () => {
        throw new Error('provider unavailable')
      }
    ]
  ])('fails closed when shell-conflict confirmation returns %s', async (_case, confirm) => {
    const confirmForegroundProcess = vi.fn(confirm)
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'zsh',
      confirmForegroundProcess
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: false,
      status: null
    })
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
  })

  it('fails closed on a shell conflict when the controller cannot confirm it', async () => {
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'zsh'
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('skips strong confirmation when ordinary foreground evidence recognizes an agent', async () => {
    const getForegroundProcess = vi.fn(async () => 'codex')
    const confirmForegroundProcess = vi.fn(async () => 'codex')
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    expect(getForegroundProcess).toHaveBeenCalledOnce()
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('skips both foreground reads when current title evidence blocks explicit hook state', async () => {
    const getForegroundProcess = vi.fn(async () => 'zsh')
    const confirmForegroundProcess = vi.fn(async () => 'codex')
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess,
      title: 'zsh'
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: false,
      status: null
    })
    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('skips foreground reads for permission title and blocked wait evidence', async () => {
    for (const blocked of ['title', 'wait'] as const) {
      const getForegroundProcess = vi.fn(async () => 'zsh')
      const confirmForegroundProcess = vi.fn(async () => 'codex')
      const { runtime, handle } = await createExplicitAgentStatusHarness({
        getForegroundProcess,
        confirmForegroundProcess
      })
      runtime.onPtyData(
        'pty-1',
        blocked === 'title'
          ? '\x1b]0;Codex waiting for permission\x07'
          : 'Hooks need review. Press enter to confirm\n',
        Date.now() + 1000
      )
      getForegroundProcess.mockClear()
      confirmForegroundProcess.mockClear()

      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: true,
        status: 'permission'
      })
      expect(getForegroundProcess).not.toHaveBeenCalled()
      expect(confirmForegroundProcess).not.toHaveBeenCalled()
    }
  })

  it('rejects foreground evidence when the handle rebinds during the ordinary read', async () => {
    const foreground = deferred<string | null>()
    const getForegroundProcess = vi.fn(() => foreground.promise)
    const confirmForegroundProcess = vi.fn(async () => 'codex')
    const { runtime, handle, syncPty } = await createExplicitAgentStatusHarness({
      getForegroundProcess,
      confirmForegroundProcess
    })

    const status = runtime.getTerminalAgentStatus(handle)
    await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledWith('pty-1'))
    syncPty('pty-2')
    foreground.resolve('zsh')

    await expect(status).rejects.toThrow('terminal_handle_stale')
    expect(confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('rejects a handle rebind while a controller-less status check yields', async () => {
    const { runtime, handle, syncPty } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'zsh'
    })
    runtime.setPtyController(null)

    const status = runtime.getTerminalAgentStatus(handle)
    syncPty('pty-2')

    await expect(status).rejects.toThrow('terminal_handle_stale')
  })

  it('rejects confirmation evidence when the handle rebinds during the fresh read', async () => {
    const confirmation = deferred<string | null>()
    const confirmForegroundProcess = vi.fn(() => confirmation.promise)
    const { runtime, handle, syncPty } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'powershell.exe',
      confirmForegroundProcess
    })

    const status = runtime.getTerminalAgentStatus(handle)
    await vi.waitFor(() => expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-1'))
    syncPty('pty-2')
    confirmation.resolve('codex')

    await expect(status).rejects.toThrow('terminal_handle_stale')
  })

  it('rejects confirmation evidence when the owning PTY exits', async () => {
    const confirmation = deferred<string | null>()
    const confirmForegroundProcess = vi.fn(() => confirmation.promise)
    const { runtime, handle } = await createExplicitAgentStatusHarness({
      getForegroundProcess: async () => 'powershell.exe',
      confirmForegroundProcess
    })

    const status = runtime.getTerminalAgentStatus(handle)
    await vi.waitFor(() => expect(confirmForegroundProcess).toHaveBeenCalledWith('pty-1'))
    runtime.onPtyExit('pty-1', 0)
    confirmation.resolve('codex')

    await expect(status).rejects.toThrow('terminal_exited')
  })

  it('reports permission from a title-derived action-required agent state', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex waiting for permission',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('maps fresh explicit done hook state to idle for send readiness', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-1', leafId)
    const runtime = new OrcaRuntimeService(store, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'done',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'idle'
    })
  })
})
