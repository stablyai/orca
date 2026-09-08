import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../../../shared/agent-session-record'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import * as authority from '../../../../structured-worker-authority'
import { resolveNativeCoordinatorSession } from './run-scope'

const runtime = {} as OrcaRuntimeService

function record(): AgentSessionRecord {
  return {
    sessionId: 'native-session',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder',
      workspaceKind: 'folder'
    },
    lease: {
      runtimeKind: 'native',
      runtimeFence: 7,
      claimStatus: 'live',
      unreconciled: false,
      handoffStage: null
    }
  } as AgentSessionRecord
}

afterEach(() => vi.restoreAllMocks())

describe('native orchestration authority', () => {
  it('resolves an ordinary native folder session without a worker registry or PTY', () => {
    vi.spyOn(authority, 'readStructuredAgentSessionRecord').mockReturnValue(record())
    expect(resolveNativeCoordinatorSession(runtime, 'native-session', 7)).toEqual({
      sessionId: 'native-session',
      worktreeId: 'folder'
    })
  })

  it('rejects unknown sessions and stale fences', () => {
    const read = vi.spyOn(authority, 'readStructuredAgentSessionRecord').mockReturnValue(null)
    expect(() => resolveNativeCoordinatorSession(runtime, 'unknown', 7)).toThrow(
      'lease is not current'
    )
    read.mockReturnValue(record())
    expect(() => resolveNativeCoordinatorSession(runtime, 'native-session', 6)).toThrow(
      'lease is not current'
    )
  })

  it.each([
    { claimStatus: 'released' },
    { claimStatus: 'reserved' },
    { claimStatus: 'conflicted' },
    { unreconciled: true },
    { handoffStage: 'preparing' },
    { runtimeKind: 'tui' }
  ])('rejects a lease without current native ownership: %j', (patch) => {
    const value = record()
    Object.assign(value.lease, patch)
    vi.spyOn(authority, 'readStructuredAgentSessionRecord').mockReturnValue(value)
    expect(() => resolveNativeCoordinatorSession(runtime, 'native-session', 7)).toThrow(
      'lease is not current'
    )
  })
})
