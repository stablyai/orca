import { describe, expect, it, vi } from 'vitest'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../src/shared/agent-launch-runtime-capability'
import { AgentResolveDefault } from '../../../src/shared/rpc-contract/project-default-agent-params'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { RpcResponse } from '../transport/types'
import { listServerRepos } from '../worktree/server-repos'
import { resolveMobileNewWorkspaceDefaultAgent } from './new-workspace-project-default-agent'

function clientWithReplies(capabilities: string[], result: unknown, repos: unknown[] = []) {
  const client = createFakeRpcClient()
  client.sendRequest = vi.fn(async (method): Promise<RpcResponse> => ({
    id: 'r',
    ok: true,
    result:
      method === 'status.get' ? { capabilities } : method === 'repo.list' ? { repos } : result,
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

  it('translates the listed paired host into the server-native catalog scope', async () => {
    const client = clientWithReplies(
      [PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY],
      { agent: 'codex', source: 'project' },
      [repo]
    )
    const listed = await listServerRepos<typeof repo>('runtime:server-b', client)
    const target = listed?.[0]
    if (!target) {
      throw new Error('The paired server did not list the fixture repository')
    }
    expect(target.executionHostId).toBe('runtime:server-b')
    await resolveMobileNewWorkspaceDefaultAgent(client, target)
    expect(client.sendRequest).toHaveBeenCalledWith('agent.resolveDefault', {
      repo: 'id:repo-b',
      repoHostId: 'runtime:server-b'
    })
    const request = vi
      .mocked(client.sendRequest)
      .mock.calls.find(([method]) => method === 'agent.resolveDefault')
    expect(AgentResolveDefault.parse(request?.[1]).repoHostId).toBe('local')
  })

  it('preserves native SSH scope through the server request parser', async () => {
    const client = clientWithReplies([PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY], {
      agent: 'codex',
      source: 'project'
    })
    await resolveMobileNewWorkspaceDefaultAgent(client, { ...repo, connectionId: 'builder' })
    const request = vi
      .mocked(client.sendRequest)
      .mock.calls.find(([method]) => method === 'agent.resolveDefault')
    expect(AgentResolveDefault.parse(request?.[1]).repoHostId).toBe('ssh:builder')
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
