import { expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import { CAPABLE_CLIENT, methodNamed, rpcContext, runtimeStub } from './agent-launch.test-fixture'

const method = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const request = {
  agent: 'antigravity',
  launchSource: 'cli',
  surface: 'terminal',
  target: { kind: 'existing', worktree: 'id:wt-7' },
  sessionOptions: { model: 'gemini-3.8-flash-high', effort: 'low' }
}
const capturedModels = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' }
]

it('refuses the real conflicting pair before creating a terminal, using the startup cwd', async () => {
  const runtime = Object.assign(runtimeStub({ settings: {} }), {
    discoverTerminalModels: vi.fn(async () => ({
      success: true,
      catalogOrigin: 'probe',
      models: capturedModels
    }))
  })
  await expect(
    method.handler(
      method.params.parse({ ...request, cwd: '/repo/subdir' }),
      rpcContext(runtime, CAPABLE_CLIENT)
    )
  ).rejects.toMatchObject({
    code: 'invalid_argument',
    message: expect.stringContaining('--model gemini-3.8-flash --effort low')
  })
  expect(runtime.discoverTerminalModels).toHaveBeenCalledWith('id:wt-7', 'antigravity', {
    cwd: '/repo/subdir',
    uncached: true
  })
  expect(runtime.createTerminal).not.toHaveBeenCalled()
})

it('passes through inability and preserves saved profile pairs without discovery', async () => {
  const runtime = Object.assign(runtimeStub({ settings: {} }), {
    discoverTerminalModels: vi.fn(async () => {
      throw new Error('method_not_found')
    })
  })
  const explicit = await method.handler(
    method.params.parse(request),
    rpcContext(runtime, CAPABLE_CLIENT)
  )
  expect(explicit.outcome.kind).toBe('terminal')
  expect(runtime.createTerminal).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      launchPreferences: { model: 'gemini-3.8-flash-high', effort: 'low' }
    })
  )
  runtime.discoverTerminalModels.mockClear()
  await method.handler(
    method.params.parse({ ...request, launchSource: 'new-tab' }),
    rpcContext(runtime, CAPABLE_CLIENT)
  )
  expect(runtime.discoverTerminalModels).not.toHaveBeenCalled()
  expect(runtime.createTerminal).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      launchPreferences: { model: 'gemini-3.8-flash-high', effort: 'low' }
    })
  )
})

it('does not use a prospective repo listing to refuse a future worktree launch', async () => {
  const runtime = Object.assign(runtimeStub({ settings: {} }), {
    discoverTerminalModels: vi.fn(async () => ({
      success: true,
      catalogOrigin: 'probe',
      models: capturedModels
    }))
  })
  const result = await method.handler(
    method.params.parse({
      ...request,
      target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'future' } }
    }),
    rpcContext(runtime, CAPABLE_CLIENT)
  )
  expect(result.outcome.kind).toBe('terminal')
  expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
    expect.objectContaining({
      startupAgent: 'antigravity',
      startupLaunchPreferences: { model: 'gemini-3.8-flash-high', effort: 'low' }
    })
  )
})

it.each(['existing', 'create-worktree', 'create-folder-workspace'] as const)(
  'carries a model-less clear through the %s terminal launch owner',
  async (kind) => {
    const runtime = runtimeStub({ settings: {} })
    const target =
      kind === 'existing'
        ? { kind, worktree: 'id:wt-7' }
        : kind === 'create-worktree'
          ? { kind, create: { repo: 'id:repo-1', name: 'future' } }
          : { kind, create: { projectGroupId: 'group-1', folderPath: '/tmp/future' } }
    const result = await method.handler(
      method.params.parse({
        ...request,
        launchSource: 'new-tab',
        target,
        sessionOptions: undefined,
        chatOptions: { effort: 'low' },
        terminalOptionEdits: { effort: null }
      }),
      rpcContext(runtime, { ...CAPABLE_CLIENT, clientKind: 'runtime' })
    )
    expect(result.outcome.kind).toBe('terminal')
    if (kind === 'create-worktree') {
      expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ startupTerminalOptionEdits: { effort: null } })
      )
    } else {
      expect(runtime.createTerminal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ terminalOptionEdits: { effort: null } })
      )
    }
  }
)
