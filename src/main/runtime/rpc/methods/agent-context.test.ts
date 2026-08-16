import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'

vi.mock('../../../skills/skill-discovery-target', () => ({
  resolveSkillDiscoveryTarget: vi.fn((target) => ({ kind: 'native-host', cwd: target?.cwd }))
}))
vi.mock('../../../agent-context/agent-context-target', () => ({
  inspectAgentContextOnTarget: vi.fn(async (resolved) => ({
    target: { kind: 'native-host', homeDir: '/home/u', cwd: resolved.cwd ?? null },
    instructionFiles: [],
    mcpFiles: [],
    hookFiles: [],
    plugins: [],
    scannedAt: 1
  }))
}))

import { AGENT_CONTEXT_METHODS } from './agent-context'
import { inspectAgentContextOnTarget } from '../../../agent-context/agent-context-target'
import { resolveSkillDiscoveryTarget } from '../../../skills/skill-discovery-target'

const WSL_RUNTIME = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'project-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'wsl:Ubuntu'
  }
} as const

function makeContext(
  resolveProjectRuntimeForWorktree: (worktreeId: string | null | undefined) => unknown = () =>
    undefined
): RpcContext {
  return { runtime: { resolveProjectRuntimeForWorktree } } as unknown as RpcContext
}

function inspectMethod() {
  const method = AGENT_CONTEXT_METHODS.find((entry) => entry.name === 'agentContext.inspect')
  if (!method) {
    throw new Error('agentContext.inspect method not registered')
  }
  return method
}

describe('agentContext.inspect RPC', () => {
  it('resolves the same host skill discovery would, from the executing runtime', async () => {
    const resolveProjectRuntimeForWorktree = vi.fn(() => WSL_RUNTIME)
    const report = await inspectMethod().handler(
      { cwd: '/home/u/repo', worktreeId: 'worktree-1' },
      makeContext(resolveProjectRuntimeForWorktree)
    )
    expect(resolveProjectRuntimeForWorktree).toHaveBeenCalledWith('worktree-1')
    expect(vi.mocked(resolveSkillDiscoveryTarget)).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: '/home/u/repo', projectRuntime: WSL_RUNTIME })
    )
    expect(vi.mocked(inspectAgentContextOnTarget)).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: '/home/u/repo' })
    )
    expect(report).toMatchObject({ target: { cwd: '/home/u/repo' } })
  })

  it('keeps a caller-supplied project runtime', async () => {
    const resolveProjectRuntimeForWorktree = vi.fn()
    await inspectMethod().handler(
      { cwd: '/repo', worktreeId: 'worktree-1', projectRuntime: WSL_RUNTIME },
      makeContext(resolveProjectRuntimeForWorktree)
    )
    expect(resolveProjectRuntimeForWorktree).not.toHaveBeenCalled()
  })

  it('accepts an empty params payload', () => {
    expect(inspectMethod().params?.parse(undefined)).toEqual({})
  })
})
