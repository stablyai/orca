import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'

// The module imports `safeStorage` at top for its Electron cipher factory; these
// tests inject their own cipher, so a bare stub keeps the import resolvable.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8')
  }
}))

import {
  AgentLaunchOperationStore,
  type AgentLaunchOperationStoreDurableState,
  type PendingAgentLaunchSnapshot,
  type SettledAgentLaunchOperation
} from './agent-launch-operation-store'
import {
  admittedLaunchRecordsFromPendingSnapshots,
  agentLaunchOperationStorePath,
  decodeAgentLaunchOperationStore,
  encodeAgentLaunchOperationStore,
  initAgentLaunchOperationStorePersistence,
  loadAgentLaunchOperationStoreState,
  writeAgentLaunchOperationStoreState,
  type AgentLaunchOperationCipher
} from './agent-launch-operation-store-persistence'

// XOR-ish reversible transform standing in for safeStorage so the envelope
// round-trip is exercised without an OS keychain, and the on-disk pending bytes
// are verifiably NOT the plaintext.
function reversibleCipher(available: boolean): AgentLaunchOperationCipher {
  return {
    available: () => available,
    encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
    decrypt: (ciphertext) => ciphertext.toString('utf-8').replace(/^enc:/, '')
  }
}

const snapshot: AgentLaunchSnapshot = {
  version: 1,
  requestedAgent: 'claude',
  baseAgent: 'claude',
  displayLabel: 'Claude',
  mode: 'built-in',
  argv: ['claude'],
  agentEnv: { SECRET_TOKEN: 'do-not-leak' },
  capturedEnvPolicy: 'full',
  target: {
    platform: 'linux',
    execution: 'native',
    shell: 'posix',
    isRemote: false,
    executionHostId: 'local'
  }
}

function pending(token: string): PendingAgentLaunchSnapshot {
  return {
    operationId: `op-${token}`,
    idempotencyKey: `key-${token}`,
    scope: 'r1::/wt',
    clientMutationId: null,
    payloadDigest: `digest-${token}`,
    launchToken: token,
    intent: 'interactive',
    snapshot
  }
}

function settled(operationId: string): SettledAgentLaunchOperation {
  return {
    operationId,
    idempotencyKey: `key-${operationId}`,
    scope: 'r1::/wt',
    payloadDigest: `digest-${operationId}`,
    status: 'launched',
    terminalId: 'term-1',
    failureId: null,
    settledAt: 10
  }
}

describe('agent-launch operation-store persistence', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-launch-store-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips both halves through encrypted encode/decode', () => {
    const cipher = reversibleCipher(true)
    const state: AgentLaunchOperationStoreDurableState = {
      pending: [pending('tok-a')],
      settled: [settled('op-1')]
    }
    const decoded = decodeAgentLaunchOperationStore(
      encodeAgentLaunchOperationStore(state, cipher),
      cipher
    )
    expect(decoded.pending).toEqual(state.pending)
    expect(decoded.settled).toEqual(state.settled)
  })

  it('encrypts the pending section so the token never appears in cleartext on disk', () => {
    const cipher = reversibleCipher(true)
    const path = agentLaunchOperationStorePath(dir)
    writeAgentLaunchOperationStoreState(
      path,
      { pending: [pending('super-secret-token')], settled: [] },
      cipher
    )
    const bytes = readFileSync(path, 'utf-8')
    expect(bytes).not.toContain('super-secret-token')
    expect(bytes).not.toContain('do-not-leak')
    const reloaded = loadAgentLaunchOperationStoreState(path, cipher)
    expect(reloaded.pending[0]?.launchToken).toBe('super-secret-token')
  })

  it('falls back to a hardened plaintext pending section when encryption is unavailable', () => {
    const cipher = reversibleCipher(false)
    const path = agentLaunchOperationStorePath(dir)
    writeAgentLaunchOperationStoreState(path, { pending: [pending('tok-b')], settled: [] }, cipher)
    const reloaded = loadAgentLaunchOperationStoreState(path, cipher)
    expect(reloaded.pending[0]?.launchToken).toBe('tok-b')
  })

  it('returns empty state for a missing file', () => {
    expect(
      loadAgentLaunchOperationStoreState(agentLaunchOperationStorePath(dir), reversibleCipher(true))
    ).toEqual({
      pending: [],
      settled: [],
      persistedStateUnreadable: false
    })
  })

  it('keeps the settled ledger, drops pending, and flags an unreadable encrypted section', () => {
    // Written with an available cipher, reloaded with an unavailable one: the
    // encrypted pending cannot be read NOW (locked keychain), but the plaintext
    // ledger survives and the flag stops the sink from clobbering the file.
    const path = agentLaunchOperationStorePath(dir)
    writeAgentLaunchOperationStoreState(
      path,
      { pending: [pending('tok-c')], settled: [settled('op-2')] },
      reversibleCipher(true)
    )
    const reloaded = loadAgentLaunchOperationStoreState(path, reversibleCipher(false))
    expect(reloaded.pending).toEqual([])
    expect(reloaded.settled).toEqual([settled('op-2')])
    expect(reloaded.persistedStateUnreadable).toBe(true)
  })

  it('returns empty state for a corrupt file', () => {
    const path = agentLaunchOperationStorePath(dir)
    writeFileSync(path, '{ not json', 'utf-8')
    expect(loadAgentLaunchOperationStoreState(path, reversibleCipher(true))).toEqual({
      pending: [],
      settled: [],
      persistedStateUnreadable: false
    })
  })

  it('round-trips the admission principal and strips a malformed one (L2-#3)', () => {
    const cipher = reversibleCipher(true)
    const remote = { ...pending('tok-p'), principal: { kind: 'remote' as const, id: 'mobile' } }
    const decoded = decodeAgentLaunchOperationStore(
      encodeAgentLaunchOperationStore({ pending: [remote], settled: [] }, cipher),
      cipher
    )
    expect(decoded.pending[0]?.principal).toEqual({ kind: 'remote', id: 'mobile' })

    const forged = {
      ...pending('tok-q'),
      principal: { kind: 'remote' } as unknown as PendingAgentLaunchSnapshot['principal']
    }
    const stripped = decodeAgentLaunchOperationStore(
      encodeAgentLaunchOperationStore({ pending: [forged], settled: [] }, cipher),
      cipher
    )
    // The snapshot survives (crash recovery) with the junk principal dropped.
    expect(stripped.pending[0]?.launchToken).toBe('tok-q')
    expect(stripped.pending[0]?.principal).toBeUndefined()
  })
})

describe('boot init: admission rebuild + locked-keychain recovery', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-launch-store-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('derives admission records from rehydrated pendings by intent (L2-#3)', () => {
    const records = admittedLaunchRecordsFromPendingSnapshots(
      [
        { ...pending('tok-i'), scope: 'wt-1', intent: 'interactive' },
        {
          ...pending('tok-b'),
          scope: 'attempt-1',
          intent: 'background',
          principal: { kind: 'remote', id: 'mobile' }
        },
        { ...pending('tok-a'), scope: 'run-1', intent: 'automation' }
      ],
      { worktreeIdForBackgroundScope: (id) => (id === 'attempt-1' ? 'wt-bg' : null), now: () => 99 }
    )
    expect(records).toHaveLength(3)
    // Interactive/cli/resume scopes ARE the worktree; background maps through
    // its attempt; automation/orchestration name none.
    expect(records[0]).toMatchObject({
      launchToken: 'tok-i',
      worktreeId: 'wt-1',
      principal: { kind: 'local' },
      admittedAt: 99
    })
    expect(records[1]).toMatchObject({
      launchToken: 'tok-b',
      worktreeId: 'wt-bg',
      principal: { kind: 'remote', id: 'mobile' }
    })
    expect(records[2]).toMatchObject({ launchToken: 'tok-a', worktreeId: null })
  })

  it('rebuilds admission capacity from durable pendings at boot (L2-#3)', () => {
    const cipher = reversibleCipher(true)
    const path = agentLaunchOperationStorePath(dir)
    writeAgentLaunchOperationStoreState(
      path,
      { pending: [{ ...pending('tok-x'), scope: 'wt-9' }], settled: [] },
      cipher
    )
    const store = new AgentLaunchOperationStore()
    const rebuildAdmission = vi.fn()
    initAgentLaunchOperationStorePersistence(store, path, cipher, {
      rebuildAdmission,
      worktreeIdForBackgroundScope: () => null,
      now: () => 5
    })
    expect(store.getPending('tok-x')).not.toBeNull()
    expect(rebuildAdmission).toHaveBeenCalledWith([
      expect.objectContaining({ launchToken: 'tok-x', worktreeId: 'wt-9' })
    ])
  })

  it('never overwrites undecryptable pendings, then merges once the keychain unlocks (L2-#2)', () => {
    const path = agentLaunchOperationStorePath(dir)
    // Boot N-1 persisted an encrypted pending snapshot.
    writeAgentLaunchOperationStoreState(
      path,
      { pending: [pending('tok-crash')], settled: [settled('op-old')] },
      reversibleCipher(true)
    )
    // Boot N: keychain locked. A mutable-availability cipher models it
    // unlocking later in the session.
    let available = false
    const lateCipher: AgentLaunchOperationCipher = {
      available: () => available,
      encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
      decrypt: (ciphertext) => ciphertext.toString('utf-8').replace(/^enc:/, '')
    }
    const store = new AgentLaunchOperationStore()
    initAgentLaunchOperationStorePersistence(store, path, lateCipher, {
      rebuildAdmission: () => {},
      worktreeIdForBackgroundScope: () => null
    })
    expect(store.getPending('tok-crash')).toBeNull()

    // First mutation while still locked: the write-back is skipped, so the
    // on-disk ciphertext (the crash-recovery snapshot) survives untouched.
    store.recordSettled(settled('op-live'))
    expect(loadAgentLaunchOperationStoreState(path, reversibleCipher(true)).pending).toEqual([
      pending('tok-crash')
    ])

    // Keychain unlocks; the next mutation merges disk under live state and
    // re-attaches the plain write-back sink.
    available = true
    store.beginPending(pending('tok-live'))
    expect(store.getPending('tok-crash')).not.toBeNull()
    expect(store.getPending('tok-live')).not.toBeNull()
    const onDisk = loadAgentLaunchOperationStoreState(path, reversibleCipher(true))
    expect(onDisk.pending.map((entry) => entry.launchToken).sort()).toEqual([
      'tok-crash',
      'tok-live'
    ])
    expect(onDisk.settled.map((entry) => entry.operationId).sort()).toEqual(['op-live', 'op-old'])

    // Later mutations persist through the normal sink.
    store.clearPending('tok-live')
    expect(
      loadAgentLaunchOperationStoreState(path, reversibleCipher(true)).pending.map(
        (entry) => entry.launchToken
      )
    ).toEqual(['tok-crash'])
  })

  it('recovery merge with settled rows never re-enters the recovery sink (L2-#2)', () => {
    const path = agentLaunchOperationStorePath(dir)
    writeAgentLaunchOperationStoreState(
      path,
      {
        pending: [pending('tok-crash')],
        settled: [settled('op-old-1'), settled('op-old-2')]
      },
      reversibleCipher(true)
    )
    let available = false
    let decrypts = 0
    const lateCipher: AgentLaunchOperationCipher = {
      available: () => available,
      encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
      decrypt: (ciphertext) => {
        decrypts += 1
        return ciphertext.toString('utf-8').replace(/^enc:/, '')
      }
    }
    const store = new AgentLaunchOperationStore()
    initAgentLaunchOperationStorePersistence(store, path, lateCipher, {
      rebuildAdmission: () => {},
      worktreeIdForBackgroundScope: () => null
    })

    available = true
    store.recordSettled(settled('op-live'))

    // Exactly one disk read for the merge. A persisting rebuildSettledFrom
    // would re-enter the still-attached recovery sink once per rehydrated
    // settled row, re-reading (and re-decrypting) the file recursively.
    expect(decrypts).toBe(1)
    expect(store.getPending('tok-crash')).not.toBeNull()
    const onDisk = loadAgentLaunchOperationStoreState(path, reversibleCipher(true))
    expect(onDisk.pending.map((entry) => entry.launchToken)).toEqual(['tok-crash'])
    expect(onDisk.settled.map((entry) => entry.operationId).sort()).toEqual([
      'op-live',
      'op-old-1',
      'op-old-2'
    ])
  })
})
