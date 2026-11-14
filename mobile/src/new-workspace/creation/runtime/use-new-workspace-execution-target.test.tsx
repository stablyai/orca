import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSession } from '../../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'

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
})
