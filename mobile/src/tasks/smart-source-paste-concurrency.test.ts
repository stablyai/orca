import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useSmartWorkspaceSource } from './use-smart-workspace-source'

function Probe(props: { client: RpcClient; query: string }) {
  useSmartWorkspaceSource({
    client: props.client,
    enabled: true,
    mode: 'smart',
    query: props.query,
    repoId: 'repo-1',
    githubAvailable: true,
    gitlabAvailable: false,
    linearAvailable: false,
    jiraAvailable: false,
    jiraSites: [],
    mrStateFilter: 'opened',
    repos: [{ id: 'repo-1', displayName: 'orca', slug: { owner: 'stablyai', repo: 'orca' } }]
  })
  return null
}

// Fan-out and exact lookup are independent round trips; serializing them adds a full host round trip to pasted PRs.
describe('smart source paste lookup concurrency', () => {
  const mounted: ReactTestRenderer[] = []

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    act(() => {
      for (const renderer of mounted) {
        renderer.unmount()
      }
    })
    mounted.length = 0
    vi.useRealTimers()
  })

  it('issues the pasted-number lookup while the fan-out is still in flight', async () => {
    const sent: string[] = []
    const sendRequest = vi.fn((method: string) => {
      sent.push(method)
      // Leave requests pending so only concurrently issued requests can be observed.
      return new Promise(() => {})
    })
    const client = { sendRequest } as unknown as RpcClient

    await act(async () => {
      mounted.push(create(createElement(Probe, { client, query: '16831' })))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(sent).toContain('github.listWorkItems')
    expect(sent).toContain('github.workItem')
  })
})
