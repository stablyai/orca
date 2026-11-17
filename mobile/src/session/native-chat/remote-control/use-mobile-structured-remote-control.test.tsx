import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  act(() => renderer?.unmount())
  vi.resetAllMocks()
})

function remoteControlOfFailedLink(): MobileStructuredRemoteControl {
  let seen: MobileStructuredRemoteControl | undefined
  function Probe(): null {
    seen = useMobileStructuredRemoteControl(
      {
        client: {} as never,
        sessionId: 'session-1',
        agent: 'claude',
        hostSupport: { providerRemoteControl: true, statusFeed: true } as never,
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
