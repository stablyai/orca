import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../../../src/shared/agent-session/agent-session-wire'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../transport/connection/connection-state'
import '../../../transport/connection/stable-logical-rpc-client'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'
import { stubRpcClient } from '../../../transport/rpc/rpc-client-test-stub'

function summary(stopping: boolean): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    agent: 'codex',
    status: 'working',
    latestPrompt: 'ship it',
    updatedAt: 1,
    hostExecutionOwned: true,
    ...(stopping ? { stopping: true } : {})
  }
}

describe("the phone's status stream", () => {
  let frames: ((value: unknown) => void)[]
  let stateListeners: ((state: ConnectionState) => void)[]
  let client: RpcClient

  beforeEach(() => {
    frames = []
    stateListeners = []
    // A fresh client per test: the stream is one per client for its life.
    client = stubRpcClient({
      subscribe: vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
        frames.push(onData)
        return () => {}
      }),
      onStateChange: (listener: (state: ConnectionState) => void) => {
        stateListeners.push(listener)
        return () => {}
      }
    })
  })

  function read(): AgentSessionStatusSummary | undefined {
    return mobileStructuredSessionStatusFeed(client).getSnapshot().get('session-1')
  }

  function connection(state: ConnectionState): void {
    for (const listener of stateListeners) {
      listener(state)
    }
  }

  it('keeps a retrying host owned and starting until readiness, then revokes ownership on disconnect', () => {
    mobileStructuredSessionStatusFeed(client).subscribe(() => {})
    const starting = { ...summary(false), hostExecutionPhase: 'starting' as const }
    frames[0]?.({ type: 'snapshot', sessions: [starting] })
    frames[0]?.({ type: 'status', session: starting })
    expect(read()).toMatchObject({ hostExecutionOwned: true, hostExecutionPhase: 'starting' })
    frames[0]?.({ type: 'status', session: { ...starting, hostExecutionPhase: 'ready' } })
    expect(read()).toMatchObject({ hostExecutionOwned: true, hostExecutionPhase: 'ready' })
    connection('reconnecting')
    expect(read()?.hostExecutionOwned).toBeUndefined()
    expect(read()?.hostExecutionPhase).toBeUndefined()
  })
})

// Match physical registry ordering: drop ended streams before delivering their last frame.
