// One root cause, three durable launch stores: a read failure that the loader
// swallowed came back as "no data", and the write-back sink then persisted that
// empty set over intact bytes on the very next mutation. These tests hold the
// distinction the fix introduces — ABSENT (empty is the truth) vs UNREADABLE
// (the bytes are fine, this process just cannot see them right now).

import type * as NodeFsModule from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const unreadablePaths = new Set<string>()

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsModule>()
  const readFileSync = (path: unknown, ...rest: unknown[]): unknown => {
    if (typeof path === 'string' && unreadablePaths.has(path)) {
      const error = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
  }
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8')
  }
}))

import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  agentSessionRecordStorePath,
  initAgentSessionRecordStorePersistence,
  loadAgentSessionRecordStoreState,
  writeAgentSessionRecordStoreState,
  type AgentSessionRecordCipher
} from './agent-session-record-store-persistence'
import { BackgroundAgentLaunchStore } from './background-agent-launch-store'
import {
  backgroundAgentLaunchStorePath,
  initBackgroundAgentLaunchStorePersistence,
  loadBackgroundAgentLaunchAttempts,
  writeBackgroundAgentLaunchAttempts
} from './background-agent-launch-store-persistence'

const plaintextCipher: AgentSessionRecordCipher = {
  available: () => false,
  encrypt: (plaintext) => Buffer.from(plaintext, 'utf-8'),
  decrypt: (ciphertext) => ciphertext.toString('utf-8')
}

const snapshot: AgentLaunchSnapshot = {
  version: 1,
  requestedAgent: 'claude',
  baseAgent: 'claude',
  displayLabel: 'Claude',
  mode: 'built-in',
  argv: ['claude'],
  agentEnv: {},
  capturedEnvPolicy: 'full',
  target: {
    platform: 'linux',
    execution: 'native',
    shell: 'posix',
    isRemote: false,
    executionHostId: 'local'
  }
}

/** Reads through the mock by lifting the block for the duration of the read. */
function readWhileReadable<T>(path: string, read: () => T): T {
  unreadablePaths.delete(path)
  try {
    return read()
  } finally {
    unreadablePaths.add(path)
  }
}

describe('durable launch stores with an unreadable persisted file', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'launch-store-unreadable-'))
  })

  afterEach(() => {
    unreadablePaths.clear()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps session records on disk while the file cannot be read, then merges them', () => {
    const path = agentSessionRecordStorePath(dir)
    writeAgentSessionRecordStoreState(
      path,
      {
        records: [
          {
            worktreeId: 'wt-1',
            requestedAgent: 'claude',
            baseAgent: 'claude',
            providerSession: { key: 'session_id', id: 'sess-persisted' },
            launchSnapshot: snapshot,
            registeredAt: 1,
            updatedAt: 1
          }
        ]
      },
      plaintextCipher
    )
    unreadablePaths.add(path)

    const store = new AgentSessionRecordStore()
    initAgentSessionRecordStorePersistence(store, path, plaintextCipher)
    // The in-memory set is a partial view, so the tombstone owner scanner must
    // not treat it as the complete reference set.
    expect(store.recordCompleteness.isComplete()).toBe(false)

    store.register({
      worktreeId: 'wt-2',
      requestedAgent: 'claude',
      baseAgent: 'claude',
      launchSnapshot: snapshot,
      launchToken: 'tok-live'
    })
    store.bindProviderSessionByToken('tok-live', { key: 'session_id', id: 'sess-live' })
    expect(
      readWhileReadable(path, () =>
        loadAgentSessionRecordStoreState(path, plaintextCipher).records.map(
          (entry) => entry.providerSession.id
        )
      )
    ).toEqual(['sess-persisted'])

    // Reads recover: the next mutation merges disk under memory and takes over.
    unreadablePaths.delete(path)
    store.register({
      worktreeId: 'wt-3',
      requestedAgent: 'claude',
      baseAgent: 'claude',
      launchSnapshot: snapshot,
      launchToken: 'tok-3'
    })
    store.bindProviderSessionByToken('tok-3', { key: 'session_id', id: 'sess-3' })
    expect(store.recordCompleteness.isComplete()).toBe(true)
    expect(
      loadAgentSessionRecordStoreState(path, plaintextCipher)
        .records.map((entry) => entry.providerSession.id)
        .sort()
    ).toEqual(['sess-3', 'sess-live', 'sess-persisted'])
  })

  it('keeps background attempts on disk while the file cannot be read, then merges them', () => {
    const path = backgroundAgentLaunchStorePath(dir)
    writeBackgroundAgentLaunchAttempts(path, [
      {
        attemptId: '0199f7a1-0000-7000-8000-0000000000b1',
        worktreeId: 'r1::/wt',
        operationId: 'op-persisted',
        requestedAgent: 'claude',
        baseAgent: null,
        state: 'pending',
        failure: null,
        createdAt: 1,
        updatedAt: 1,
        forgottenAt: null
      }
    ])
    unreadablePaths.add(path)

    const store = new BackgroundAgentLaunchStore({ now: () => 1000 })
    initBackgroundAgentLaunchStorePersistence(store, path)
    expect(store.attemptCompleteness.isComplete()).toBe(false)

    store.create({
      attemptId: '0199f7a1-0000-7000-8000-0000000000b2',
      worktreeId: 'r1::/wt',
      operationId: 'op-live',
      requestedAgent: 'claude',
      baseAgent: null
    })
    // The unattended-failure recovery card the persisted attempt renders must
    // survive the mutation.
    expect(
      readWhileReadable(path, () =>
        loadBackgroundAgentLaunchAttempts(path).attempts.map((a) => a.operationId)
      )
    ).toEqual(['op-persisted'])

    unreadablePaths.delete(path)
    store.create({
      attemptId: '0199f7a1-0000-7000-8000-0000000000b3',
      worktreeId: 'r1::/wt',
      operationId: 'op-recovered',
      requestedAgent: 'claude',
      baseAgent: null
    })
    expect(store.attemptCompleteness.isComplete()).toBe(true)
    expect(
      loadBackgroundAgentLaunchAttempts(path)
        .attempts.map((a) => a.operationId)
        .sort()
    ).toEqual(['op-live', 'op-persisted', 'op-recovered'])
  })

  it('does not resurrect an attempt pruned while the file was unreadable', () => {
    const path = backgroundAgentLaunchStorePath(dir)
    const pruned = '0199f7a1-0000-7000-8000-0000000000c1'
    writeBackgroundAgentLaunchAttempts(path, [
      {
        attemptId: pruned,
        worktreeId: 'r1::/wt',
        operationId: 'op-pruned',
        requestedAgent: 'claude',
        baseAgent: null,
        state: 'launched',
        failure: null,
        createdAt: 1,
        updatedAt: 1,
        forgottenAt: null
      }
    ])
    unreadablePaths.add(path)

    const store = new BackgroundAgentLaunchStore({ now: () => 1000 })
    initBackgroundAgentLaunchStorePersistence(store, path)
    store.delete(pruned)

    unreadablePaths.delete(path)
    store.create({
      attemptId: '0199f7a1-0000-7000-8000-0000000000c2',
      worktreeId: 'r1::/wt',
      operationId: 'op-live',
      requestedAgent: 'claude',
      baseAgent: null
    })
    expect(loadBackgroundAgentLaunchAttempts(path).attempts.map((a) => a.operationId)).toEqual([
      'op-live'
    ])
  })
})
