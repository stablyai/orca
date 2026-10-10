import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { useMobileStructuredAgentAcceptsImages } from './use-mobile-structured-agent-accepts-images'

async function answerAgents(client: FakeRpcClient, agents: unknown): Promise<void> {
  await act(async () => {
    client.requests[0]!.resolve({
      id: 'agents',
      ok: true,
      result: { agents },
      _meta: { runtimeId: 'runtime-1' }
    })
  })
}

const capabilities = (imagePrompts: boolean) => ({
  rewind: false,
  compact: true,
  threadGoal: false,
  contextUsage: true,
  imagePrompts,
  steering: 'queue',
  approvalEnforcement: 'orca'
})

describe('useMobileStructuredAgentAcceptsImages', () => {
  let renderer: ReactTestRenderer | null = null
  let accepts: boolean | null = null

  function Harness(props: Parameters<typeof useMobileStructuredAgentAcceptsImages>[0]): null {
    accepts = useMobileStructuredAgentAcceptsImages(props)
    return null
  }

  async function mount(props: Parameters<typeof useMobileStructuredAgentAcceptsImages>[0]) {
    await act(async () => {
      renderer = create(createElement(Harness, props))
    })
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    accepts = null
  })

  it("answers by the agent's host record", async () => {
    const client = createFakeRpcClient()
    await mount({ client, hostListsAgents: true, agent: 'opencode' })
    expect(client.requests.map((request) => request.args)).toEqual([['agentSession.agents', {}]])
    // Unlisted until the host answers: only the built-ins take images.
    expect(accepts).toBe(false)
    await answerAgents(client, [
      { agent: 'grok', capabilities: capabilities(false) },
      { agent: 'opencode', capabilities: capabilities(true) }
    ])
    expect(accepts).toBe(true)

    await act(async () => {
      renderer!.update(createElement(Harness, { client, hostListsAgents: true, agent: 'grok' }))
    })
    expect(accepts).toBe(false)
    expect(client.requests).toHaveLength(1)
  })

  it('asks a host that lists no agents nothing and offers images only to the built-ins', async () => {
    const client = createFakeRpcClient()
    await mount({ client, hostListsAgents: false, agent: 'claude' })
    expect(accepts).toBe(true)
    await act(async () => {
      renderer!.update(createElement(Harness, { client, hostListsAgents: false, agent: 'grok' }))
    })
    expect(accepts).toBe(false)
    expect(client.requests).toHaveLength(0)
  })
})
