import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentLaunchWorkspaceFactory } from './agent-launch-worktree-creation'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const createStructuredSession = vi.fn(async (_args: Record<string, unknown>) => ({
  ok: true as const,
  value: { sessionId: 'setup-session' }
}))
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (args: Record<string, unknown>) =>
    createStructuredSession(args)
}))
const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}
async function launch(params: unknown, runtime: AgentLaunchRuntimeStub) {
  return AGENT_LAUNCH.handler(
    AGENT_LAUNCH.params.parse(params),
    rpcContext(runtime, CAPABLE_CLIENT)
  )
}
beforeEach(() => createStructuredSession.mockClear())

describe('required setup before an agent launch', () => {
  it('waits for setup before replacing a terminal that failed to spawn', async () => {
    vi.useFakeTimers()
    try {
      const runtime = runtimeStub({ settings: {} })
      runtime.createManagedWorktree.mockResolvedValueOnce({
        worktree: { id: 'wt-new' },
        startupTerminal: undefined,
        setupReceipt: {
          startupPolicy: 'wait-for-setup',
          state: 'running',
          terminalHandle: 'setup-1'
        }
      })
      let complete: (value: { exitCode: number | null }) => void = () => {}
      runtime.waitForSetupTerminalCompletion.mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve
          })
      )
      const pending = launch(CREATE_LAUNCH, runtime)
      await vi.advanceTimersByTimeAsync(60_001)
      expect(runtime.createTerminal).not.toHaveBeenCalled()
      complete({ exitCode: 0 })
      expect((await pending).outcome.kind).toBe('terminal')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a replacement terminal when its required setup failed', async () => {
    const runtime = runtimeStub({ settings: {} })
    runtime.createManagedWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-new' },
      startupTerminal: undefined,
      setupReceipt: { startupPolicy: 'wait-for-setup', state: 'running', terminalHandle: 'setup-1' }
    })
    runtime.waitForSetupTerminalCompletion.mockResolvedValue({ exitCode: 23 })
    await expect(launch(CREATE_LAUNCH, runtime)).rejects.toMatchObject({
      code: 'agent_setup_failed'
    })
    expect(runtime.createTerminal).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startupAgent: expect.anything() })
    )
  })

  it.each(['spawn_failed', 'running'] as const)(
    'does not start a terminal fallback when required setup is %s without an observer',
    async (state) => {
      const runtime = runtimeStub({ settings: {} })
      runtime.createManagedWorktree.mockResolvedValueOnce({
        worktree: { id: 'wt-new' },
        startupTerminal: undefined,
        setupReceipt: { startupPolicy: 'wait-for-setup', state }
      })
      await expect(launch(CREATE_LAUNCH, runtime)).rejects.toMatchObject({
        code: 'agent_setup_unconfirmed'
      })
      expect(runtime.createTerminal).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ startupAgent: expect.anything() })
      )
    }
  )
  it('keeps chat startup pending beyond sixty seconds until setup succeeds', async () => {
    vi.useFakeTimers()
    try {
      const runtime = runtimeStub({
        setupReceipt: {
          startupPolicy: 'wait-for-setup',
          state: 'running',
          terminalHandle: 'setup-1'
        }
      })
      let complete: (value: { exitCode: number | null }) => void = () => {}
      runtime.waitForSetupTerminalCompletion.mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve
          })
      )
      const pending = launch(CREATE_LAUNCH, runtime)
      await vi.advanceTimersByTimeAsync(60_001)
      expect(createStructuredSession).not.toHaveBeenCalled()
      complete({ exitCode: 0 })
      expect((await pending).outcome.kind).toBe('structured')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([23, null])(
    'declines chat startup when setup completion reports %s',
    async (exitCode) => {
      const runtime = runtimeStub({
        setupReceipt: {
          startupPolicy: 'wait-for-setup',
          state: 'running',
          terminalHandle: 'setup-1'
        }
      })
      runtime.waitForSetupTerminalCompletion.mockResolvedValue({ exitCode })
      await expect(launch(CREATE_LAUNCH, runtime)).rejects.toThrow(/setup/i)
      expect(createStructuredSession).not.toHaveBeenCalled()
      expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    }
  )

  it('declines chat startup when required setup cannot be observed', async () => {
    const runtime = runtimeStub({
      setupReceipt: {
        startupPolicy: 'wait-for-setup',
        state: 'spawn_failed'
      }
    })
    await expect(launch(CREATE_LAUNCH, runtime)).rejects.toThrow(/setup/i)
    expect(createStructuredSession).not.toHaveBeenCalled()
  })

  it('declines chat startup when running setup has no completion handle', async () => {
    const runtime = runtimeStub({
      setupReceipt: { startupPolicy: 'wait-for-setup', state: 'running' }
    })
    await expect(launch(CREATE_LAUNCH, runtime)).rejects.toThrow(/setup/i)
    expect(createStructuredSession).not.toHaveBeenCalled()
  })

  it('declines chat startup when setup observation fails', async () => {
    const runtime = runtimeStub({
      setupReceipt: {
        startupPolicy: 'wait-for-setup',
        state: 'running',
        terminalHandle: 'setup-1'
      }
    })
    runtime.waitForSetupTerminalCompletion.mockRejectedValue(new Error('terminal disappeared'))
    await expect(launch(CREATE_LAUNCH, runtime)).rejects.toThrow(/setup/i)
    expect(createStructuredSession).not.toHaveBeenCalled()
  })

  it('declines chat startup and cancels observation after the setup deadline', async () => {
    vi.useFakeTimers()
    try {
      const runtime = runtimeStub({
        setupReceipt: {
          startupPolicy: 'wait-for-setup',
          state: 'running',
          terminalHandle: 'setup-1'
        }
      })
      runtime.waitForSetupTerminalCompletion.mockImplementation(() => new Promise(() => {}))
      const refused = expect(launch(CREATE_LAUNCH, runtime)).rejects.toThrow(/setup/i)
      await Promise.all([refused, vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)])
      expect(createStructuredSession).not.toHaveBeenCalled()
      expect(runtime.waitForSetupTerminalCompletion.mock.calls[0]?.[1]?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels setup observation when its pending launch is cancelled', async () => {
    vi.useFakeTimers()
    try {
      const runtime = runtimeStub({
        setupReceipt: {
          startupPolicy: 'wait-for-setup',
          state: 'running',
          terminalHandle: 'setup-1'
        }
      })
      runtime.waitForSetupTerminalCompletion.mockImplementation(
        (_handle, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
      )
      const controller = new AbortController()
      const pending = agentLaunchWorkspaceFactory(rpcContext(runtime, CAPABLE_CLIENT), 'claude')
        .createWorktree({
          create: CREATE_LAUNCH.target.create,
          startupAgent: undefined,
          signal: controller.signal
        })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(1)
      controller.abort()
      await vi.advanceTimersByTimeAsync(1)
      expect(runtime.waitForSetupTerminalCompletion.mock.calls[0]?.[1]?.aborted).toBe(true)
      expect(await pending).toMatchObject({ message: 'request_aborted' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a setup-gated structured workspace before creating its session', async () => {
    const runtime = runtimeStub({
      setupReceipt: {
        startupPolicy: 'wait-for-setup',
        state: 'running',
        terminalHandle: 'setup-1'
      }
    })
    const order: string[] = []
    runtime.waitForSetupTerminalCompletion.mockImplementation(async () => {
      order.push('setup-complete')
      return { exitCode: 0 }
    })
    createStructuredSession.mockImplementationOnce(async () => {
      order.push('structured-create')
      return { ok: true as const, value: { sessionId: 'sess-1' } }
    })

    await launch(CREATE_LAUNCH, runtime)

    expect(order).toEqual(['setup-complete', 'structured-create'])
    expect(runtime.waitForSetupTerminalCompletion).toHaveBeenCalledWith(
      'setup-1',
      expect.any(AbortSignal)
    )
  })
})
