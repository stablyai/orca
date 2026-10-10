import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentAcceptsImages } from './use-mobile-structured-agent-accepts-images'

function clientListing(agents: unknown): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  return {
    sendRequest: vi.fn(async () => ({
      id: 'agents',
      ok: true,
      result: { agents },
      _meta: { runtimeId: 'runtime-1' }
    }))
  } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
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
    const client = clientListing([
      { agent: 'grok', capabilities: capabilities(false) },
      { agent: 'opencode', capabilities: capabilities(true) }
    ])
    await mount({ client, hostListsAgents: true, agent: 'grok' })
    expect(client.sendRequest).toHaveBeenCalledWith('agentSession.agents', {})
    expect(accepts).toBe(false)

    await act(async () => {
      renderer!.update(createElement(Harness, { client, hostListsAgents: true, agent: 'opencode' }))
    })
    expect(accepts).toBe(true)
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('asks a host that lists no agents nothing and offers images only to the built-ins', async () => {
    const client = clientListing([])
    await mount({ client, hostListsAgents: false, agent: 'claude' })
    expect(accepts).toBe(true)
    await act(async () => {
      renderer!.update(createElement(Harness, { client, hostListsAgents: false, agent: 'grok' }))
    })
    expect(accepts).toBe(false)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
})
