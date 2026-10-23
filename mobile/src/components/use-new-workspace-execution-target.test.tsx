import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useNewWorkspaceExecutionTarget } from './use-new-workspace-execution-target'

const mounted: ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount())
  }
})

describe('New Workspace agent detection', () => {
  it('targets the picked repo and clears the previous repo agents while switching', async () => {
    const client = new FakeSession('connected')
    let resolveNext: ((response: { id: string; ok: true; result: string[] }) => void) | undefined
    client.sendRequest.mockImplementation(async (_method: string, params?: unknown) => {
      if (JSON.stringify(params) === JSON.stringify({ repoId: 'wsl-repo' })) {
        return { id: 'reply', ok: true, result: ['claude'] }
      }
      return new Promise((resolve) => {
        resolveNext = resolve
      })
    })
    let detected: Set<string> | null = null
    function Harness({
      repoId,
      selectedClient = client
    }: {
      repoId: string
      selectedClient?: RpcClient
    }) {
      detected = useNewWorkspaceExecutionTarget({
        client: selectedClient,
        repoId,
        connectionId: null,
        visible: true
      }).detectedAgentIds
      return null
    }
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(Harness, { repoId: 'wsl-repo' }))
      mounted.push(renderer)
    })
    expect(client.sendRequest).toHaveBeenCalledWith('preflight.detectAgents', {
      repoId: 'wsl-repo'
    })
    expect(detected).toEqual(new Set(['claude']))
    await act(async () => {
      renderer?.update(createElement(Harness, { repoId: 'host-repo' }))
    })
    expect(detected).toBeNull()
    expect(client.sendRequest).toHaveBeenLastCalledWith('preflight.detectAgents', {
      repoId: 'host-repo'
    })
    await act(async () => {
      resolveNext?.({ id: 'reply', ok: true, result: ['codex'] })
    })
    expect(detected).toEqual(new Set(['codex']))
    const otherHost = new FakeSession('connected')
    otherHost.sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveNext = resolve
        })
    )
    await act(async () => {
      renderer?.update(createElement(Harness, { repoId: 'host-repo', selectedClient: otherHost }))
    })
    expect(detected).toBeNull()
    await act(async () => {
      resolveNext?.({ id: 'reply', ok: true, result: ['gemini'] })
    })
    expect(detected).toEqual(new Set(['gemini']))
  })

  it.each([
    { switchHost: false, rejectLate: false },
    { switchHost: false, rejectLate: true },
    { switchHost: true, rejectLate: false },
    { switchHost: true, rejectLate: true }
  ])(
    'ignores late results after switching ($switchHost host, $rejectLate rejection)',
    async ({ switchHost, rejectLate }) => {
      const originalClient = new FakeSession('connected')
      const currentClient = switchHost ? new FakeSession('connected') : originalClient
      let settleLate: (() => void) | undefined
      originalClient.sendRequest.mockImplementationOnce(
        () =>
          new Promise<RpcResponse>((resolve, reject) => {
            settleLate = () =>
              rejectLate
                ? reject(new Error('old host disconnected'))
                : resolve({ id: 'late', ok: true, result: ['claude'] })
          })
      )
      currentClient.sendRequest.mockResolvedValue({ id: 'current', ok: true, result: ['codex'] })
      let detected: Set<string> | null = null
      function Harness({ client, repoId }: { client: RpcClient; repoId: string }) {
        detected = useNewWorkspaceExecutionTarget({
          client,
          repoId,
          connectionId: null,
          visible: true
        }).detectedAgentIds
        return null
      }
      let renderer: ReactTestRenderer | undefined
      await act(async () => {
        renderer = create(createElement(Harness, { client: originalClient, repoId: 'repo-1' }))
        mounted.push(renderer)
      })
      expect(detected).toBeNull()
      await act(async () => {
        renderer?.update(
          createElement(Harness, {
            client: currentClient,
            repoId: switchHost ? 'repo-1' : 'repo-2'
          })
        )
      })
      expect(detected).toEqual(new Set(['codex']))
      await act(async () => settleLate?.())
      expect(detected).toEqual(new Set(['codex']))
    }
  )

  it('keeps the SSH request and connection gate', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method: string) => ({
      id: 'reply',
      ok: true,
      result:
        method === 'ssh.getState'
          ? { state: { targetId: 'ssh-1', status: 'connected', error: null, reconnectAttempt: 0 } }
          : ['codex']
    }))
    function Harness() {
      useNewWorkspaceExecutionTarget({
        client,
        repoId: 'remote-repo',
        connectionId: 'ssh-1',
        visible: true
      })
      return null
    }
    await act(async () => {
      mounted.push(create(createElement(Harness)))
    })
    expect(client.sendRequest).toHaveBeenCalledWith('preflight.detectRemoteAgents', {
      connectionId: 'ssh-1'
    })
    expect(
      client.sendRequest.mock.calls.some(([method]) => method === 'preflight.detectAgents')
    ).toBe(false)
  })
})
