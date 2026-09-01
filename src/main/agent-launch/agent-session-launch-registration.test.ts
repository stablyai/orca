// U5: the shared spawn-success registration helper stages the admitted snapshot
// (read host-private from the boundary, never the client receipt) keyed by launch
// token, and no-ops when the snapshot is gone or the worktree id is empty.
import { describe, expect, it } from 'vitest'
import type { AgentLaunchReceipt } from '../../shared/agent-launch-contract'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { registerHostSessionLaunch } from './agent-session-launch-registration'
import type { AgentLaunchBoundary } from './agent-launch-boundary'

function snapshot(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'custom-agent:claude:reviewer',
    baseAgent: 'claude',
    displayLabel: 'Reviewer',
    mode: 'custom',
    argv: ['claude'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'darwin',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    }
  }
}

const RECEIPT: AgentLaunchReceipt = {
  requestedAgent: 'custom-agent:claude:reviewer',
  baseAgent: 'claude',
  notices: [],
  launchToken: 'token-a',
  catalogRevision: 1,
  telemetry: { agentKind: 'claude-code', usedCustomAgent: true }
}

/** A boundary stub exposing the two snapshot accessors the helper reads. `where`
 *  selects whether the snapshot is post-settle (retained) or mid-spawn (pending). */
function boundaryWith(
  snap: AgentLaunchSnapshot | null,
  where: 'retained' | 'pending' = 'retained'
): AgentLaunchBoundary {
  const hit = (token: string): AgentLaunchSnapshot | null => (token === 'token-a' ? snap : null)
  return {
    retainedFor: (token: string) =>
      where === 'retained' && hit(token) ? { snapshot: hit(token) } : null,
    pendingSnapshotFor: (token: string) => (where === 'pending' ? hit(token) : null)
  } as unknown as AgentLaunchBoundary
}

const OWNERSHIP = { worktreeId: 'wt-1', baseAgent: 'claude' as const, providerSessionId: 'sess-1' }

describe('registerHostSessionLaunch', () => {
  it('stages the retained snapshot so a later hook bind makes it resumable', () => {
    const store = new AgentSessionRecordStore()
    registerHostSessionLaunch({
      boundary: boundaryWith(snapshot()),
      store,
      launchToken: 'token-a',
      worktreeId: 'wt-1',
      receipt: RECEIPT,
      paneKey: 'pane-a',
      terminalId: 'term-a'
    })
    // Staged, not yet resumable, until the hook binds a provider session.
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()
    store.bindProviderSessionByToken('token-a', { key: 'session_id', id: 'sess-1' })
    const record = store.resolveByOwnershipKey(OWNERSHIP)
    expect(record?.launchSnapshot).toEqual(snapshot())
    expect(record?.requestedAgent).toBe('custom-agent:claude:reviewer')
  })

  it('stages a mid-spawn launch from the pending admission snapshot (pre-settle)', () => {
    const store = new AgentSessionRecordStore()
    registerHostSessionLaunch({
      boundary: boundaryWith(snapshot(), 'pending'),
      store,
      launchToken: 'token-a',
      worktreeId: 'wt-1',
      receipt: RECEIPT
    })
    expect(
      store.bindProviderSessionByToken('token-a', { key: 'session_id', id: 'sess-1' })
    ).not.toBeNull()
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.launchSnapshot).toEqual(snapshot())
  })

  it('no-ops when the admitted snapshot is no longer retained', () => {
    const store = new AgentSessionRecordStore()
    registerHostSessionLaunch({
      boundary: boundaryWith(null),
      store,
      launchToken: 'token-a',
      worktreeId: 'wt-1',
      receipt: RECEIPT
    })
    expect(
      store.bindProviderSessionByToken('token-a', { key: 'session_id', id: 'sess-1' })
    ).toBeNull()
  })

  it('no-ops for an empty worktree id (never resolvable by an ownership key)', () => {
    const store = new AgentSessionRecordStore()
    registerHostSessionLaunch({
      boundary: boundaryWith(snapshot()),
      store,
      launchToken: 'token-a',
      worktreeId: '',
      receipt: RECEIPT
    })
    expect(
      store.bindProviderSessionByToken('token-a', { key: 'session_id', id: 'sess-1' })
    ).toBeNull()
  })
})
