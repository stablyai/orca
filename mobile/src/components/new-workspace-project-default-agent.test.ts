import { describe, expect, it, vi } from 'vitest'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../src/shared/agent-launch-runtime-capability'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { RpcResponse } from '../transport/types'
import { resolveMobileNewWorkspaceDefaultAgent } from './new-workspace-project-default-agent'

function clientWithReplies(capabilities: string[], result: unknown) {
  const client = createFakeRpcClient()
  client.sendRequest = vi.fn(async (method): Promise<RpcResponse> => ({
    id: 'r',
    ok: true,
    result: method === 'status.get' ? { capabilities } : result,
    _meta: { runtimeId: 'host' }
  }))
  return client
}

describe('mobile new workspace project default', () => {
  const repo = { id: 'repo-b', displayName: 'B', path: '/b' }

  it('resolves on the target host with the target repository', async () => {
    const client = clientWithReplies([PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY], {
      agent: 'codex',
      source: 'project',
      projectId: 'b',
      projectName: 'B'
    })
    await expect(resolveMobileNewWorkspaceDefaultAgent(client, repo)).resolves.toMatchObject({
      agent: 'codex',
      source: 'project'
    })
    expect(client.sendRequest).toHaveBeenCalledWith('agent.resolveDefault', {
      repo: 'id:repo-b',
      repoHostId: 'local'
    })
  })

  it('keeps the paired host identity on an otherwise ambiguous repository ID', async () => {
    const client = clientWithReplies([PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY], {
      agent: 'codex',
      source: 'project'
    })
    await resolveMobileNewWorkspaceDefaultAgent(client, {
      ...repo,
      executionHostId: 'runtime:server-b'
    })
    expect(client.sendRequest).toHaveBeenCalledWith('agent.resolveDefault', {
      repo: 'id:repo-b',
      repoHostId: 'runtime:server-b'
    })
  })

  it('keeps blank terminal as a host-resolved choice', async () => {
    const client = clientWithReplies([PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY], {
      agent: null,
      source: 'project',
      projectName: 'B'
    })
    await expect(resolveMobileNewWorkspaceDefaultAgent(client, repo)).resolves.toMatchObject({
      agent: null,
      source: 'project'
    })
  })

  it('refuses an older host before asking it to resolve', async () => {
    const client = clientWithReplies([], { agent: 'claude', source: 'global' })
    await expect(resolveMobileNewWorkspaceDefaultAgent(client, repo)).rejects.toThrow(
      'Update the target Orca host'
    )
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('forwards an unavailable configured agent error without substituting', async () => {
    const client = createFakeRpcClient()
    client.sendRequest = vi.fn(async (method): Promise<RpcResponse> =>
      method === 'status.get'
        ? {
            id: 'status',
            ok: true,
            result: { capabilities: [PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY] },
            _meta: { runtimeId: 'host' }
          }
        : {
            id: 'resolve',
            ok: false,
            error: { code: 'agent_unavailable', message: 'Codex is unavailable on B' }
          }
    )
    await expect(resolveMobileNewWorkspaceDefaultAgent(client, repo)).rejects.toThrow(
      'Codex is unavailable on B'
    )
  })
})
