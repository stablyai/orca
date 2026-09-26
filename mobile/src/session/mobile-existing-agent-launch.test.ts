import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import {
  AGENT_LAUNCH_UNCONFIRMED_MESSAGE,
  PROMPTED_AGENT_LAUNCH_TIMEOUT_MS,
  launchAgentInExistingWorkspace,
  supportsMobileExistingAgentLaunch
} from './mobile-existing-agent-launch'

// A connected client whose only behaviour is the scripted `sendRequest`.
function requestPortRpcClient(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

function requestParam(params: unknown, key: string): unknown {
  return params && typeof params === 'object' && key in params
    ? Object.getOwnPropertyDescriptor(params, key)?.value
    : undefined
}

const LAUNCH_CAPABILITIES = [
  'agent.launch.v2',
  'agent.launch.replay.v1',
  'agent.launch.replay-required.v1'
]
const RECEIPT = {
  mode: 'terminal',
  preferred: 'terminal',
  reason: 'user_default',
  detail: 'Started a terminal agent.'
}

function launched(result: Record<string, unknown>): RpcResponse {
  return {
    id: '1',
    ok: true,
    result: {
      outcome: { kind: 'terminal', handle: 'term-1' },
      worktreeId: 'wt-1',
      receipt: RECEIPT,
      ...result
    },
    _meta: { runtimeId: 'r' }
  }
}

function refused(code: string, message = code): RpcResponse {
  return { id: '1', ok: false, error: { code, message }, _meta: { runtimeId: 'r' } }
}

function scriptedClient(...outcomes: Array<RpcResponse | { throws: unknown }>) {
  let call = 0
  const sendRequest = vi.fn(async (_method: string, _params?: unknown, _options?: unknown) => {
    const outcome = outcomes[Math.min(call, outcomes.length - 1)]!
    call += 1
    if ('throws' in outcome) {
      throw outcome.throws
    }
    return outcome
  })
  return { client: requestPortRpcClient(sendRequest), sendRequest }
}

function launch(
  client: RpcClient,
  extra: Partial<Parameters<typeof launchAgentInExistingWorkspace>[0]> = {}
) {
  return launchAgentInExistingWorkspace({
    client,
    hostCapabilities: LAUNCH_CAPABILITIES,
    worktreeId: 'wt-1',
    agent: 'claude',
    mintOperationId: () => 'op-1',
    ...extra
  })
}

describe('supportsMobileExistingAgentLaunch', () => {
  it('requires the replay ledger, not just agent.launch', () => {
    expect(supportsMobileExistingAgentLaunch(LAUNCH_CAPABILITIES)).toBe(true)
    expect(supportsMobileExistingAgentLaunch(['agent.launch.v2'])).toBe(false)
    expect(supportsMobileExistingAgentLaunch([])).toBe(false)
    expect(supportsMobileExistingAgentLaunch(undefined)).toBe(false)
  })
})

describe('launchAgentInExistingWorkspace', () => {
  it('sends nothing to a host without the launch capabilities', async () => {
    const { client, sendRequest } = scriptedClient(launched({}))
    await expect(launch(client, { hostCapabilities: ['agent.launch.v2'] })).resolves.toEqual({
      kind: 'unsupported'
    })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('launches through agent.launchReplay into the existing workspace with the prompt', async () => {
    const { client, sendRequest } = scriptedClient(
      launched({ prompt: { delivery: 'submit', outcome: 'handed-to-terminal' } })
    )
    const result = await launch(client, {
      prompt: { text: 'Fix it', delivery: 'submit' },
      launchSource: 'task_page'
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'agent.launchReplay',
      {
        agent: 'claude',
        operationId: 'op-1',
        target: { kind: 'existing', worktree: 'id:wt-1' },
        prompt: { text: 'Fix it', delivery: 'submit' },
        launchSource: 'task_page'
      },
      // The host may wait 60s for the agent before pasting; the default 30s would give up first.
      { timeoutMs: PROMPTED_AGENT_LAUNCH_TIMEOUT_MS }
    )
    expect(result).toMatchObject({ kind: 'launched', promptDelivered: true })
  })

  it('keeps the default timeout for a launch with no prompt', async () => {
    const { client, sendRequest } = scriptedClient(launched({}))
    await expect(launch(client)).resolves.toMatchObject({
      kind: 'launched',
      promptDelivered: null
    })
    expect(sendRequest.mock.calls[0]![2]).toBeUndefined()
  })

  it('reports a journaled prompt as delivered', async () => {
    const { client } = scriptedClient(
      launched({
        outcome: { kind: 'structured', sessionId: 'claude_s1', handle: 'h' },
        prompt: { delivery: 'submit', outcome: 'journaled', messageId: 'm-1' }
      })
    )
    await expect(
      launch(client, { prompt: { text: 'Fix it', delivery: 'submit' } })
    ).resolves.toMatchObject({ kind: 'launched', promptDelivered: true })
  })

  it('reports not-delivered so the caller keeps the prompt', async () => {
    const { client } = scriptedClient(
      launched({ prompt: { delivery: 'submit', outcome: 'not-delivered' } })
    )
    await expect(
      launch(client, { prompt: { text: 'Fix it', delivery: 'submit' } })
    ).resolves.toMatchObject({ kind: 'launched', promptDelivered: false })
  })

  it('under-claims a prompted launch whose receipt carries no prompt disposal', async () => {
    const { client } = scriptedClient(launched({}))
    await expect(
      launch(client, { prompt: { text: 'Fix it', delivery: 'submit' } })
    ).resolves.toMatchObject({ kind: 'launched', promptDelivered: false })
  })

  it('treats a refusal of the first send as an unsupported host', async () => {
    const { client } = scriptedClient(refused('agent_launch_replay_unsupported'))
    await expect(launch(client)).resolves.toEqual({ kind: 'unsupported' })
  })

  it('never reads a refusal after a replay as unsupported: the first attempt may have run', async () => {
    const { client, sendRequest } = scriptedClient(
      { throws: markRpcDeliveryUnknown(new Error('Connection interrupted')) },
      refused('agent_launch_replay_unsupported')
    )
    await expect(launch(client)).resolves.toEqual({
      kind: 'unknown',
      message: AGENT_LAUNCH_UNCONFIRMED_MESSAGE
    })
    // The replay reuses the same operation id.
    expect(sendRequest.mock.calls.map(([, params]) => requestParam(params, 'operationId'))).toEqual(
      ['op-1', 'op-1']
    )
  })

  it('maps an unknown outcome to readable copy instead of the raw code', async () => {
    const { client } = scriptedClient(refused('agent_session_operation_unknown'))
    await expect(launch(client)).resolves.toEqual({
      kind: 'unknown',
      message: AGENT_LAUNCH_UNCONFIRMED_MESSAGE
    })
  })

  it('surfaces a refusal from before the launch with the host message', async () => {
    const { client } = scriptedClient(refused('selector_not_found', 'Workspace not found'))
    await expect(launch(client)).resolves.toEqual({
      kind: 'failed',
      message: 'Workspace not found'
    })
  })

  it('reports unknown when no answer arrives at all', async () => {
    const { client } = scriptedClient({ throws: new Error('Request timed out') })
    await expect(launch(client)).resolves.toEqual({
      kind: 'unknown',
      message: AGENT_LAUNCH_UNCONFIRMED_MESSAGE
    })
  })

  it('mints a new operation for every call so a later tap is a new launch', async () => {
    const { client, sendRequest } = scriptedClient(launched({}))
    const ids = ['op-a', 'op-b']
    await launch(client, { mintOperationId: () => ids.shift()! })
    await launch(client, { mintOperationId: () => ids.shift()! })
    expect(sendRequest.mock.calls.map(([, params]) => requestParam(params, 'operationId'))).toEqual(
      ['op-a', 'op-b']
    )
  })

  it('works against a v1.4.206-shaped host', async () => {
    // v1.4.206 (the first release with these capabilities) parses a plain object that knows only
    // these keys and strips the rest; its terminal arm starts the agent without the prompt.
    const v1_4_206Keys = new Set([
      'agent',
      'operationId',
      'target',
      'prompt',
      'sessionOptions',
      'reuseTerminal'
    ])
    let parsed: Record<string, unknown> | null = null
    const client = requestPortRpcClient(async (_method, params) => {
      parsed = Object.fromEntries(
        Object.entries(params ?? {}).filter(([key]) => v1_4_206Keys.has(key))
      )
      return launched({ prompt: { delivery: 'submit', outcome: 'not-delivered' } })
    })
    const result = await launch(client, {
      prompt: { text: 'Fix it', delivery: 'submit' },
      launchSource: 'task_page'
    })
    // Only telemetry is lost; the launch itself carries nothing that host would drop.
    expect(parsed).toEqual({
      agent: 'claude',
      operationId: 'op-1',
      target: { kind: 'existing', worktree: 'id:wt-1' },
      prompt: { text: 'Fix it', delivery: 'submit' }
    })
    expect(result).toMatchObject({ kind: 'launched', promptDelivered: false })
  })
})
