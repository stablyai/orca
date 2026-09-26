import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileCommitFailureRecovery } from './mobile-commit-failure-recovery'

vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
vi.mock('../components/HostProtocolGate', () => ({
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reaches the client only through sendRequest.
  return { client: { sendRequest } as unknown as RpcClient, sendRequest }
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

  it('reports the host warning on a launch that went ahead as a warning, not an error', async () => {
    const rerender = mount(hostClient(async () => LAUNCHED_WITH_WARNING).client)
    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await recovery?.launch()
    })
    expect(succeeded).toBe(true)
    expect(recovery?.launchError).toBeNull()
    expect(recovery?.launchWarning).toBe('the requested arguments were ignored.')
    // A new failure is a new launch; the old one's note does not carry over.
    rerender({ ...FAILURE, error: 'another hook failed' })
    expect(recovery?.launchWarning).toBeNull()
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
})
