import { describe, expect, it, beforeEach } from 'vitest'
import { isTerminalLeafId, parsePaneKey } from '../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../shared/structured-agent-session-projection'
import { selectExactWorkerProviderSession } from './orchestration/worker-provider-session'
import { structuredWorkerChildIdentityEnv } from './structured-worker-child-identity-env'
import {
  StructuredWorkerIdentityRegistry,
  isStructuredWorkerHandle,
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  sessionIdFromStructuredWorkerIncarnation,
  structuredWorkerHostScope,
  structuredWorkerPaneKeyBelongsToSession,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation,
  structuredWorkerRecordIsCurrent
} from './structured-worker-identity'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function record(overrides: {
  runtimeKind?: 'native' | 'tui'
  claimStatus?: AgentSessionRecord['lease']['claimStatus']
  executionHostId?: string
  wslDistro?: string | null
  runtimeFence?: number
}): AgentSessionRecord {
  return {
    schemaVersion: 2,
    sessionId: SESSION_ID,
    location: {
      executionHostId: overrides.executionHostId ?? 'local',
      wslDistro: overrides.wslDistro ?? null,
      workspaceId: 'wt_1',
      workspaceKind: 'git-worktree'
    },
    provider: 'claude',
    providerHandleChain: [],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/me/.claude' },
    lease: {
      sessionId: SESSION_ID,
      runtimeKind: overrides.runtimeKind ?? 'native',
      runtimeFence: overrides.runtimeFence ?? 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: 0,
      lastRenewedAt: 0,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'k',
      claimStatus: overrides.claimStatus ?? 'live',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: 0,
    updatedAt: 0
  } as AgentSessionRecord
}

describe('structured worker identity', () => {
  it('mints a random bearer handle that is never derived from the session id', () => {
    const first = mintStructuredWorkerHandle()
    const second = mintStructuredWorkerHandle()
    expect(first).not.toBe(second)
    expect(isStructuredWorkerHandle(first)).toBe(true)
    expect(first).not.toContain(SESSION_ID)
    expect(first.startsWith('term_')).toBe(false)
  })

  it('mints an UNGUESSABLE pane key, because check accepts a caller-supplied one', () => {
    // A derivable pane key would let anyone who learns a session id read that worker's mailbox:
    // orchestration.check falls back to params.terminalPaneKey and matches assignee_pane_key.
    const first = mintStructuredWorkerPaneKey(SESSION_ID)
    const second = mintStructuredWorkerPaneKey(SESSION_ID)
    expect(first).not.toBe(second)
    // The TAB half legitimately names the session; it is the LEAF that must be unguessable,
    // because both dispatch lookups key on the leaf (exact match, then leaf-suffix equivalence).
    expect(parsePaneKey(first)!.leafId).not.toContain(SESSION_ID.slice(0, 8))
    // Specifically not the sha256-of-session-id helper the chat tab projection uses.
    expect(first).not.toBe(
      structuredAgentSessionPaneKey(`structured-agent-session-${SESSION_ID}`, SESSION_ID)
    )
  })

  it("accepts a persisted pane key for its own session and rejects another session's", () => {
    const paneKey = mintStructuredWorkerPaneKey(SESSION_ID)
    expect(structuredWorkerPaneKeyBelongsToSession(paneKey, SESSION_ID)).toBe(true)
    expect(structuredWorkerPaneKeyBelongsToSession(paneKey, 'another-session-id')).toBe(false)
    expect(structuredWorkerPaneKeyBelongsToSession('not-a-pane-key', SESSION_ID)).toBe(false)
    expect(structuredWorkerPaneKeyBelongsToSession(null, SESSION_ID)).toBe(false)
  })

  it('derives a pane key whose leaf passes the terminal leaf check', () => {
    const paneKey = mintStructuredWorkerPaneKey(SESSION_ID)
    const parsed = parsePaneKey(paneKey)
    expect(parsed).not.toBeNull()
    expect(isTerminalLeafId(parsed!.leafId)).toBe(true)
    expect(parsed!.tabId).toBe(`structured-agent-session-${SESSION_ID}`)
  })

  it('round-trips the session id through the process incarnation', () => {
    const incarnation = structuredWorkerProcessIncarnation(SESSION_ID)
    expect(sessionIdFromStructuredWorkerIncarnation(incarnation)).toBe(SESSION_ID)
    expect(sessionIdFromStructuredWorkerIncarnation('ptyid:3')).toBeNull()
  })

  it('claims local authority only for a local, non-WSL session', () => {
    expect(structuredWorkerHostScope(record({}).location)).toEqual({
      kind: 'local',
      hostId: 'local'
    })
    expect(structuredWorkerHostScope(record({ wslDistro: 'Ubuntu' }).location)).toBeNull()
    expect(structuredWorkerHostScope(record({ executionHostId: 'ssh-1' }).location)).toBeNull()
  })

  it('keeps a recovered session current across a fence bump', () => {
    // The host bumps the fence on its own transparent crash recovery; fencing identity on it
    // would wedge the SAME worker as identity_unproven forever.
    expect(structuredWorkerRecordIsCurrent(record({ runtimeFence: 1 }))).toBe(true)
    expect(structuredWorkerRecordIsCurrent(record({ runtimeFence: 9 }))).toBe(true)
    expect(structuredWorkerProcessIncarnation(SESSION_ID)).toBe(
      structuredWorkerProcessIncarnation(SESSION_ID)
    )
  })

  it('refuses a session handed to a TUI owner or released', () => {
    expect(structuredWorkerRecordIsCurrent(record({ runtimeKind: 'tui' }))).toBe(false)
    expect(structuredWorkerRecordIsCurrent(record({ claimStatus: 'released' }))).toBe(false)
    expect(structuredWorkerRecordIsCurrent(null)).toBe(false)
  })
})

describe('structured worker identity registry', () => {
  let registry: StructuredWorkerIdentityRegistry

  beforeEach(() => {
    registry = new StructuredWorkerIdentityRegistry()
  })

  it('rehydrates a durable row whose persisted pane key belongs to its session', () => {
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(SESSION_ID)
    const identity = registry.rehydrate({
      terminal_handle: handle,
      pane_key: paneKey,
      process_incarnation: structuredWorkerProcessIncarnation(SESSION_ID),
      worktree_id: 'wt_1',
      host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })
    expect(identity?.sessionId).toBe(SESSION_ID)
    // The leaf is random, so the durable row is the ONLY place it survives a restart.
    expect(identity?.paneKey).toBe(paneKey)
    expect(registry.get(handle)?.handle).toBe(handle)
    expect(registry.getBySessionId(SESSION_ID)?.handle).toBe(handle)
  })

  it('refuses a row whose pane key does not match its own session id', () => {
    expect(
      registry.rehydrate({
        terminal_handle: mintStructuredWorkerHandle(),
        pane_key: mintStructuredWorkerPaneKey('some-other-session-id'),
        process_incarnation: structuredWorkerProcessIncarnation(SESSION_ID),
        worktree_id: 'wt_1',
        host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
      })
    ).toBeNull()
  })

  it('forgets both indexes', () => {
    const handle = mintStructuredWorkerHandle()
    registry.register({
      handle,
      sessionId: SESSION_ID,
      agent: 'claude',
      paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    registry.forget(handle)
    expect(registry.get(handle)).toBeNull()
    expect(registry.getBySessionId(SESSION_ID)).toBeNull()
  })
})

describe('structured workers stay outside the PTY-only fail-closed paths', () => {
  it('keeps the selector shut by never letting a structured pane key reach a hook status', () => {
    // The selector matches on pane key, so it is fail-closed for a structured worker only while
    // ORCA_PANE_KEY is absent from its child's environment. That absence IS the guard: put the key
    // back and the first assertion below is what an attacker gets.
    // The PROCESS registry, because that is the one the spawn path reads.
    const handle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_ID,
      agent: 'claude',
      paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    try {
      const env = structuredWorkerChildIdentityEnv(SESSION_ID, {})
      // Registered, so this is a populated env — not the empty one an unregistered session gets,
      // which would satisfy the pane-key assertion for the wrong reason.
      expect(env.ORCA_TERMINAL_HANDLE).toBe(handle)
      expect(Object.keys(env)).not.toContain('ORCA_PANE_KEY')
    } finally {
      structuredWorkerIdentities.forget(handle)
    }

    const paneKey = mintStructuredWorkerPaneKey(SESSION_ID)
    expect(
      selectExactWorkerProviderSession({
        paneKey,
        processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
        connectionId: null,
        launchToken: null,
        observedAfter: 0,
        statuses: [
          {
            paneKey,
            connectionId: null,
            launchToken: null,
            receivedAt: 10,
            agentType: 'claude',
            providerSession: { id: 'p1', transcriptPath: null }
          } as never
        ]
      })
    ).not.toBeNull()
    // With no hook status at all — the real structured case — it is null.
    expect(
      selectExactWorkerProviderSession({
        paneKey,
        processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
        connectionId: null,
        launchToken: null,
        observedAfter: 0,
        statuses: []
      })
    ).toBeNull()
  })
})
