import { describe, expect, it } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import {
  AgentSessionRecordStore,
  type HostSessionLaunchRecord,
  type StagedLaunchRegistration
} from './agent-session-record-store'
import { forgetDeletedVaultSessionRecords } from './agent-session-vault-delete-forget'

const CUSTOM_CODEX_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as const

function snapshot(overrides: Partial<AgentLaunchSnapshot> = {}): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: CUSTOM_CODEX_ID,
    baseAgent: 'codex',
    displayLabel: 'Original Codex',
    mode: 'custom',
    argv: ['codex', '--model', 'gpt-5.6-Sol', '-c', 'model_reasoning_effort=medium'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'linux',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    },
    ...overrides
  }
}

function record(overrides: Partial<HostSessionLaunchRecord> = {}): HostSessionLaunchRecord {
  return {
    worktreeId: 'wt-source',
    requestedAgent: CUSTOM_CODEX_ID,
    baseAgent: 'codex',
    providerSession: {
      key: 'session_id',
      id: 'provider-session',
      transcriptPath: '/home/me/.codex/sessions/transcript.jsonl'
    },
    launchSnapshot: snapshot(),
    registeredAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function resolve(
  store: AgentSessionRecordStore,
  overrides: Partial<Parameters<AgentSessionRecordStore['resolveVaultSnapshotOwner']>[0]> = {}
) {
  return store.resolveVaultSnapshotOwner({
    baseAgent: 'codex',
    scannedProviderSessionId: 'provider-session',
    scannedTranscriptPath: '/home/me/.codex/sessions/transcript.jsonl',
    targetExecutionHostId: 'local',
    targetPlatform: 'linux',
    preferredWorktreeId: 'wt-destination',
    ...overrides
  })
}

describe('AgentSessionRecordStore Vault correlation', () => {
  it('uses a strong transcript match even when scanned and hook ids differ', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([record()])
    expect(resolve(store, { scannedProviderSessionId: 'scanner-id' })).toEqual({
      kind: 'found',
      sessionKey: {
        worktreeId: 'wt-source',
        baseAgent: 'codex',
        providerSessionId: 'provider-session'
      }
    })
  })

  it('excludes a repeated provider id with a known different transcript', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([record()])
    expect(
      resolve(store, { scannedTranscriptPath: '/home/me/.codex/sessions/other.jsonl' })
    ).toEqual({ kind: 'missing' })
  })

  it('prefers the destination worktree and otherwise refuses ambiguous owners', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      record({
        worktreeId: 'wt-destination',
        providerSession: { key: 'session_id', id: 'provider-session' }
      }),
      record({
        worktreeId: 'wt-other',
        providerSession: { key: 'session_id', id: 'provider-session' }
      })
    ])
    expect(resolve(store, { scannedTranscriptPath: null })).toMatchObject({
      kind: 'found',
      sessionKey: { worktreeId: 'wt-destination' }
    })
    expect(resolve(store, { scannedTranscriptPath: null, preferredWorktreeId: 'wt-none' })).toEqual(
      { kind: 'ambiguous' }
    )
  })

  it('accepts a sole cross-worktree owner', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      record({ providerSession: { key: 'session_id', id: 'provider-session' } })
    ])
    expect(resolve(store, { scannedTranscriptPath: null })).toMatchObject({
      kind: 'found',
      sessionKey: { worktreeId: 'wt-source' }
    })
  })

  it('matches a WSL UNC scan path to the hook-reported POSIX transcript', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      record({
        launchSnapshot: snapshot({
          target: {
            platform: 'linux',
            execution: 'wsl',
            shell: 'posix',
            isRemote: false,
            executionHostId: 'wsl:Ubuntu'
          }
        })
      })
    ])
    expect(
      resolve(store, {
        scannedProviderSessionId: 'different-scanner-id',
        scannedTranscriptPath: '\\\\wsl$\\Ubuntu\\home\\me\\.codex\\sessions\\transcript.jsonl',
        targetExecutionHostId: 'wsl:Ubuntu'
      })
    ).toMatchObject({ kind: 'found' })
    expect(
      resolve(store, {
        scannedTranscriptPath: '\\\\wsl$\\Debian\\home\\me\\.codex\\sessions\\transcript.jsonl',
        targetExecutionHostId: 'wsl:Ubuntu'
      })
    ).toEqual({ kind: 'missing' })

    expect(
      store.resolveVaultSnapshotArguments({
        baseAgent: 'codex',
        scannedProviderSessionId: 'different-scanner-id',
        scannedTranscriptPath: '\\\\wsl$\\Ubuntu\\home\\me\\.codex\\sessions\\transcript.jsonl',
        scannedExecutionHostId: 'local'
      })
    ).toEqual(['--model', 'gpt-5.6-Sol', '-c', 'model_reasoning_effort=medium'])
  })

  it('skips snapshotless, base-mismatched, and target-mismatched records', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      record({ launchSnapshot: undefined }),
      record({
        worktreeId: 'wt-base-mismatch',
        launchSnapshot: snapshot({ baseAgent: 'claude' })
      }),
      record({
        worktreeId: 'wt-other-target',
        launchSnapshot: snapshot({
          target: { ...snapshot().target, executionHostId: 'ssh:box', isRemote: true }
        })
      })
    ])
    expect(resolve(store)).toEqual({ kind: 'missing' })
  })

  it('skips corrupt snapshot and provider metadata while retaining no replay authority', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      record({
        worktreeId: 'wt-bad-env',
        launchSnapshot: snapshot({ agentEnv: [] as unknown as Record<string, string> })
      }),
      record({
        worktreeId: 'wt-bad-provider-key',
        providerSession: { key: 'conversation_id', id: 'provider-session' }
      })
    ])
    expect(resolve(store)).toEqual({ kind: 'missing' })
  })

  it('updates indexes on overwrite, stale rollback, forget, and rehydrate', () => {
    const store = new AgentSessionRecordStore()
    const registration = (launchToken: string): Omit<StagedLaunchRegistration, 'registeredAt'> => ({
      worktreeId: 'wt-source',
      requestedAgent: CUSTOM_CODEX_ID,
      baseAgent: 'codex',
      launchSnapshot: snapshot(),
      launchToken,
      paneKey: launchToken,
      terminalId: launchToken
    })
    store.register(registration('old-token'))
    store.bindProviderSessionByToken('old-token', {
      key: 'session_id',
      id: 'provider-session',
      transcriptPath: '/old.jsonl'
    })
    store.register(registration('new-token'))
    store.bindProviderSessionByToken('new-token', {
      key: 'session_id',
      id: 'provider-session',
      transcriptPath: '/new.jsonl'
    })
    store.rollbackByToken('old-token')
    expect(resolve(store, { scannedTranscriptPath: '/new.jsonl' })).toMatchObject({ kind: 'found' })
    expect(resolve(store, { scannedTranscriptPath: '/old.jsonl' })).toEqual({ kind: 'missing' })

    const durable = store.durableState()
    const rebuilt = new AgentSessionRecordStore()
    rebuilt.rebuildRecordsFrom(durable.records)
    expect(resolve(rebuilt, { scannedTranscriptPath: '/new.jsonl' })).toMatchObject({
      kind: 'found'
    })
    expect(
      rebuilt.forget({
        worktreeId: 'wt-source',
        baseAgent: 'codex',
        providerSessionId: 'provider-session'
      })
    ).toBe(true)
    expect(resolve(rebuilt, { scannedTranscriptPath: '/new.jsonl' })).toEqual({ kind: 'missing' })
  })
})

describe('forgetDeletedVaultSessionRecords', () => {
  const deletedIdentity = {
    baseAgent: 'codex' as const,
    scannedProviderSessionId: 'provider-session',
    scannedTranscriptPath: '/home/me/.codex/sessions/transcript.jsonl',
    scannedExecutionHostId: 'local'
  }

  it('forgets EVERY owner of the deleted transcript, ambiguous ones included', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      record(),
      record({
        worktreeId: 'wt-other',
        providerSession: { key: 'session_id', id: 'provider-session' }
      })
    ])
    expect(forgetDeletedVaultSessionRecords(store, deletedIdentity)).toBe(2)
    expect(store.durableState().records).toEqual([])
    expect(
      store.resolveByOwnershipKey({
        worktreeId: 'wt-source',
        baseAgent: 'codex',
        providerSessionId: 'provider-session'
      })
    ).toBeNull()
  })

  it('keeps other-host records and repeated provider ids with a different transcript', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      record({
        worktreeId: 'wt-remote',
        launchSnapshot: snapshot({
          target: { ...snapshot().target, executionHostId: 'ssh:box', isRemote: true }
        })
      }),
      record({
        worktreeId: 'wt-other-transcript',
        providerSession: {
          key: 'session_id',
          id: 'provider-session',
          transcriptPath: '/home/me/.codex/sessions/other.jsonl'
        }
      })
    ])
    expect(forgetDeletedVaultSessionRecords(store, deletedIdentity)).toBe(0)
    expect(store.durableState().records).toHaveLength(2)
  })

  it('forgets a local snapshotless record by provider identity, keeping remote-owned ones', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      record({ launchSnapshot: undefined }),
      record({
        worktreeId: 'wt-remote-legacy',
        launchSnapshot: undefined,
        legacyConnectionId: 'conn-1'
      })
    ])
    expect(forgetDeletedVaultSessionRecords(store, deletedIdentity)).toBe(1)
    expect(store.durableState().records).toMatchObject([{ worktreeId: 'wt-remote-legacy' }])
  })

  it('cannot be resurrected by a late rehydrated-records merge', () => {
    const store = new AgentSessionRecordStore()
    const persisted = record()
    store.rebuildRecordsFrom([persisted])
    expect(forgetDeletedVaultSessionRecords(store, deletedIdentity)).toBe(1)
    store.mergeRehydratedRecords([persisted])
    expect(store.durableState().records).toEqual([])
  })
})
