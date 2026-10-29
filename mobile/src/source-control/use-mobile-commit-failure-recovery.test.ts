import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileCommitFailureRecovery } from './mobile-commit-failure-recovery'

vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
vi.mock('../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({
    hostCapabilities: [
      'agent.launch.v2',
      'agent.launch.replay.v1',
      'agent.launch.replay-required.v1'
    ],
    statusPending: false,
    statusReadable: true
  })
}))

import { useMobileCommitFailureRecovery } from './use-mobile-commit-failure-recovery'
import { stubRpcClient } from '../transport/rpc-client-test-stub'

type Recovery = ReturnType<typeof useMobileCommitFailureRecovery>

function rpcReply(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'r' } }
}

const LAUNCHED_WITH_WARNING = rpcReply({
  outcome: { kind: 'terminal', handle: 'term-1' },
  worktreeId: 'wt-1',
  receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' },
  prompt: { delivery: 'submit', outcome: 'handed-to-terminal' },
  warning: 'the requested arguments were ignored.'
})

function hostClient(launchReply: () => Promise<RpcResponse>) {
  const sendRequest = vi.fn(async (method: string): Promise<RpcResponse> => {
    if (method === 'repo.list') {
      return rpcReply({ repos: [{ id: 'wt-1' }] })
    }
    if (method === 'settings.get') {
      return rpcReply({ settings: { defaultTuiAgent: 'codex' } })
    }
    if (method === 'preflight.detectAgents') {
      return rpcReply(['codex'])
    }
    return launchReply()
  })
  return { client: stubRpcClient({ sendRequest }), sendRequest }
}

const FAILURE: MobileCommitFailureRecovery = {
  error: 'pre-commit hook failed',
  commitMessage: 'wip',
  stagedEntries: []
}

describe('useMobileCommitFailureRecovery', () => {
  let renderer: ReactTestRenderer | null = null
  let recovery: Recovery | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    recovery = null
  })

  function mount(client: RpcClient, failure: MobileCommitFailureRecovery | null = FAILURE) {
    function Harness(props: { failure: MobileCommitFailureRecovery | null }): null {
      recovery = useMobileCommitFailureRecovery({
        client,
        connState: 'connected',
        worktreeId: 'wt-1',
        failure: props.failure
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness, { failure }))
    })
    return (next: MobileCommitFailureRecovery | null) =>
      act(() => renderer?.update(createElement(Harness, { failure: next })))
  }

  it('retains the launched surface and host warning for this failure', async () => {
    const rerender = mount(hostClient(async () => LAUNCHED_WITH_WARNING).client)
    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await recovery?.launch()
    })
    expect(succeeded).toBe(true)
    expect(recovery?.launchError).toBeNull()
    expect(recovery?.launchedAgent).toMatchObject({
      worktreeId: 'wt-1',
      outcome: { kind: 'terminal', handle: 'term-1' },
      warning: 'the requested arguments were ignored.'
    })
    rerender({ ...FAILURE, error: 'another hook failed' })
    expect(recovery?.launchedAgent).toBeNull()
  })

  it('starts one agent for two taps before the first one re-renders', async () => {
    let release: () => void = () => {}
    const answered = new Promise<void>((resolve) => (release = resolve))
    const { client, sendRequest } = hostClient(async () => {
      await answered
      return LAUNCHED_WITH_WARNING
    })
    mount(client)
    const launch = recovery?.launch
    let taps: boolean[] = []
    await act(async () => {
      const both = Promise.all([launch?.(), launch?.()])
      release()
      taps = (await both).map(Boolean)
    })
    expect(taps).toEqual([true, false])
    expect(
      sendRequest.mock.calls.filter(([method]) => method === 'agent.launchReplay')
    ).toHaveLength(1)
  })

  it.each([
    {
      name: 'launch refusal',
      response: {
        id: 'rpc',
        ok: false,
        error: { code: 'agent_not_available', message: 'Agent is unavailable' },
        _meta: { runtimeId: 'r' }
      } satisfies RpcResponse
    },
    {
      name: 'undelivered prompt',
      response: rpcReply({
        outcome: { kind: 'terminal', handle: 'term-1' },
        worktreeId: 'wt-1',
        receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' },
        prompt: { delivery: 'submit', outcome: 'not-delivered' }
      })
    }
  ])('keeps a delayed $name attached to its original failure', async ({ response }) => {
    const reply = Promise.withResolvers<RpcResponse>()
    const rerender = mount(hostClient(() => reply.promise).client)
    let launched: Promise<boolean> | undefined
    await act(async () => {
      launched = recovery?.launch()
    })
    rerender({ ...FAILURE, error: 'another hook failed' })
    await act(async () => {
      reply.resolve(response)
      expect(await launched).toBe(false)
    })
    expect(recovery?.launchError).toBeNull()
    expect(recovery?.launchedAgent).toBeNull()
    expect(recovery?.undeliveredPrompt).toBeNull()

    rerender(FAILURE)
    expect(recovery?.launchError).toBeTruthy()
  })
})
