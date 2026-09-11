import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useNewWorkspaceExecutionTarget } from './use-new-workspace-execution-target'

function createClient(
  handler: (method: string, params?: unknown) => Promise<unknown>
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  return {
    sendRequest: vi.fn(handler),
    subscribe: vi.fn(() => () => {})
  } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

async function renderExecutionTarget(args: {
  client: RpcClient
  connectionId: string | null
  repoPath: string | null
}): Promise<void> {
  function Probe(): null {
    useNewWorkspaceExecutionTarget({ ...args, visible: true })
    return null
  }
  await act(async () => {
    create(createElement(Probe))
  })
}

describe('useNewWorkspaceExecutionTarget agent detection', () => {
  it('detects agents inside the distro of a WSL-hosted repo', async () => {
    const client = createClient(async () => ({ ok: true, result: ['claude'] }))

    await renderExecutionTarget({
      client,
      connectionId: null,
      repoPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\project'
    })

    expect(client.sendRequest).toHaveBeenCalledWith('preflight.detectAgents', {
      wslDistro: 'Ubuntu-24.04'
    })
  })

  it('leaves the target unset for a repo on the host filesystem', async () => {
    const client = createClient(async () => ({ ok: true, result: ['codex'] }))

    await renderExecutionTarget({ client, connectionId: null, repoPath: 'C:\\dev\\project' })

    expect(client.sendRequest).toHaveBeenCalledWith('preflight.detectAgents', undefined)
  })

  it('keeps resolving an SSH repo through its connection', async () => {
    const client = createClient(async (method) =>
      method === 'ssh.getState'
        ? { ok: true, result: { state: { targetId: 'ssh-1', status: 'connected', error: null } } }
        : { ok: true, result: ['claude'] }
    )

    await renderExecutionTarget({
      client,
      connectionId: 'ssh-1',
      repoPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\project'
    })

    expect(client.sendRequest).not.toHaveBeenCalledWith('preflight.detectAgents', expect.anything())
  })
})
