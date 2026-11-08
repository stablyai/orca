import { describe, expect, it, beforeEach } from 'vitest'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { selectExactWorkerProviderSession } from '../../workers/transcripts/worker-provider-session'
import { sealedChildEnv } from '../../../agent-session/environment/structured-session-child-env.test-support'
import {
  StructuredWorkerIdentityRegistry,
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerPaneKeyBelongsToSession,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from './structured-worker-identity'

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

describe('structured worker identity', () => {
  it('accepts only the registered pane key for its session', () => {
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(SESSION_ID)
    structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_ID,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    try {
      expect(structuredWorkerPaneKeyBelongsToSession(paneKey, SESSION_ID)).toBe(true)
      expect(
        structuredWorkerPaneKeyBelongsToSession(mintStructuredWorkerPaneKey(SESSION_ID), SESSION_ID)
      ).toBe(false)
      expect(structuredWorkerPaneKeyBelongsToSession(paneKey, 'another-session-id')).toBe(false)
      expect(structuredWorkerPaneKeyBelongsToSession('not-a-pane-key', SESSION_ID)).toBe(false)
      expect(structuredWorkerPaneKeyBelongsToSession(null, SESSION_ID)).toBe(false)
    } finally {
      structuredWorkerIdentities.forget(handle)
    }
  })

  it('rejects the deterministic public status key even for a registered worker', () => {
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(SESSION_ID)
    structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_ID,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    try {
      const statusPaneKey = structuredAgentSessionPaneKey(
        structuredAgentSessionTabId(SESSION_ID),
        SESSION_ID
      )
      expect(structuredWorkerPaneKeyBelongsToSession(statusPaneKey, SESSION_ID)).toBe(false)
    } finally {
      structuredWorkerIdentities.forget(handle)
    }
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

  it('cannot rehydrate a worker credential from a public status subject', () => {
    const handle = mintStructuredWorkerHandle()
    expect(
      registry.rehydrate({
        terminal_handle: handle,
        pane_key: structuredAgentSessionPaneKey(
          `structured-agent-session-${SESSION_ID}`,
          SESSION_ID
        ),
        process_incarnation: structuredWorkerProcessIncarnation(SESSION_ID),
        worktree_id: 'wt_1',
        host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
      })
    ).toBeNull()
    expect(registry.get(handle)).toBeNull()
    expect(registry.getBySessionId(SESSION_ID)).toBeNull()
  })
})

describe('structured workers stay outside the PTY-only fail-closed paths', () => {
  it('keeps the selector shut by never letting a structured pane key reach a hook status', () => {
    // Production spawn must omit ORCA_PANE_KEY: adding it would enable hook-based provider selection for structured workers.
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
      const env = sealedChildEnv(SESSION_ID)
      // Verify worker registration succeeded so absent pane key cannot pass for the wrong reason.
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
