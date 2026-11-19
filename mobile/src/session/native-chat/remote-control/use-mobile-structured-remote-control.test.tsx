import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { AGENT_SESSION_PROVIDER_REMOTE_CONTROL_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/view/agent-session-attention-capabilities'
import { structuredAgentSessionHostSupport } from '../agent-session/mobile-structured-agent-session-host-support'
import { callAgentSession } from '../agent-session/mobile-structured-agent-session-rpc'
import {
  useMobileStructuredRemoteControl,
  type MobileStructuredRemoteControl
} from './use-mobile-structured-remote-control'

vi.mock('../../../worktree/execution-hosts/workspace-server-context', () => ({
  useRouteRelaysCapability: () => true
}))
vi.mock('../agent-session/use-mobile-structured-session-host-execution', () => ({
  useMobileStructuredSessionProviderRemoteControl: () => ({
    state: 'failed',
    detail: 'network unreachable'
  }),
  useMobileStructuredSessionProviderRemoteControlChoice: () => 'on'
}))
vi.mock('../agent-session/mobile-structured-agent-session-rpc', () => ({
  callAgentSession: vi.fn()
}))

let renderer: ReactTestRenderer | undefined

const client: RpcClient = {
  sendRequest: vi.fn(),
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

afterEach(() => {
  act(() => renderer?.unmount())
  vi.resetAllMocks()
})

function remoteControlOfFailedLink(): MobileStructuredRemoteControl {
  let seen: MobileStructuredRemoteControl | undefined
  function Probe(): null {
    seen = useMobileStructuredRemoteControl(
      {
        client,
        sessionId: 'session-1',
        agent: 'claude',
        hostSupport: structuredAgentSessionHostSupport([
          AGENT_SESSION_PROVIDER_REMOTE_CONTROL_RUNTIME_CAPABILITY,
          AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY
        ]),
        enabled: true
      },
      {}
    ).remoteControl!
    return null
  }
  act(() => {
    renderer = create(createElement(Probe))
  })
  return seen!
}

describe('mobile Remote Control on a failed link', () => {
  it('reconnects on Retry, while the toggle still disconnects', async () => {
    vi.mocked(callAgentSession).mockResolvedValue({ status: 'ok' })
    const remoteControl = remoteControlOfFailedLink()

    await remoteControl.retry!()
    await remoteControl.toggle!()

    expect(vi.mocked(callAgentSession).mock.calls.map((call) => call[2])).toEqual([
      { sessionId: 'session-1', choice: 'on' },
      { sessionId: 'session-1', choice: 'off' }
    ])
  })
})
