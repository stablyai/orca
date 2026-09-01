// One root cause, three durable launch stores: they wrote through the NON-fsync
// writer and their sinks swallowed every write error, so a launch could report
// success while its idempotency/recovery/resume row never reached the platter
// (or vanished with the page cache on power loss). These tests hold both halves
// of the fix — the fsync'd writer, and a failed write that reaches the caller.

import type * as SecureFileModule from '../../shared/secure-file'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const durableWrites: string[] = []
const plainWrites: string[] = []
const failingWritePaths = new Set<string>()

vi.mock('../../shared/secure-file', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileModule>()
  const failIfMarked = (path: string): void => {
    if (failingWritePaths.has(path)) {
      const error = new Error(
        `ENOSPC: no space left on device, write '${path}'`
      ) as NodeJS.ErrnoException
      error.code = 'ENOSPC'
      throw error
    }
  }
  return {
    ...actual,
    writeSecureJsonFile: (path: string, value: unknown) => {
      plainWrites.push(path)
      failIfMarked(path)
      actual.writeSecureJsonFile(path, value)
    },
    writeDurableSecureJsonFile: (path: string, value: unknown) => {
      durableWrites.push(path)
      failIfMarked(path)
      actual.writeDurableSecureJsonFile(path, value)
    }
  }
})

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8')
  }
}))

import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import {
  AgentLaunchOperationStore,
  mintAgentLaunchOperationId
} from './agent-launch-operation-store'
import {
  agentLaunchOperationStorePath,
  initAgentLaunchOperationStorePersistence
} from './agent-launch-operation-store-persistence'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  agentSessionRecordStorePath,
  initAgentSessionRecordStorePersistence,
  type AgentSessionRecordCipher
} from './agent-session-record-store-persistence'
import { BackgroundAgentLaunchStore } from './background-agent-launch-store'
import {
  backgroundAgentLaunchStorePath,
  initBackgroundAgentLaunchStorePersistence
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
  capturedEnvPolicy: 'none',
  target: {
    platform: 'linux',
    execution: 'native',
    shell: 'posix',
    isRemote: false,
    executionHostId: 'local'
  }
}

function mutateOperationStore(store: AgentLaunchOperationStore, launchToken: string): void {
  store.beginPending({
    operationId: mintAgentLaunchOperationId(),
    idempotencyKey: `key-${launchToken}`,
    scope: 'wt-1',
    clientMutationId: null,
    payloadDigest: 'digest-a',
    launchToken,
    intent: 'interactive',
    snapshot
  })
}

function mutateSessionRecordStore(store: AgentSessionRecordStore, launchToken: string): void {
  store.register({
    worktreeId: 'wt-1',
    requestedAgent: 'claude',
    baseAgent: 'claude',
    launchSnapshot: snapshot,
    launchToken
  })
  store.bindProviderSessionByToken(launchToken, { key: 'session_id', id: `sess-${launchToken}` })
}

function mutateBackgroundStore(store: BackgroundAgentLaunchStore, attemptId: string): void {
  store.create({
    attemptId,
    worktreeId: 'r1::/wt',
    operationId: `op-${attemptId}`,
    requestedAgent: 'claude',
    baseAgent: null
  })
}

describe('durable launch store writes', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'launch-store-durable-'))
    durableWrites.length = 0
    plainWrites.length = 0
    failingWritePaths.clear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists the operation store through the fsync writer and surfaces failures', () => {
    const path = agentLaunchOperationStorePath(dir)
    const store = new AgentLaunchOperationStore()
    initAgentLaunchOperationStorePersistence(store, path, plaintextCipher, {
      rebuildAdmission: () => {},
      worktreeIdForBackgroundScope: () => null
    })

    mutateOperationStore(store, 'tok-ok')
    expect(durableWrites).toContain(path)
    expect(plainWrites).not.toContain(path)

    failingWritePaths.add(path)
    expect(() => mutateOperationStore(store, 'tok-fail')).toThrow(/ENOSPC/)
  })

  it('persists session records through the fsync writer and surfaces failures', () => {
    const path = agentSessionRecordStorePath(dir)
    const store = new AgentSessionRecordStore()
    initAgentSessionRecordStorePersistence(store, path, plaintextCipher)

    mutateSessionRecordStore(store, 'tok-ok')
    expect(durableWrites).toContain(path)
    expect(plainWrites).not.toContain(path)

    failingWritePaths.add(path)
    expect(() => mutateSessionRecordStore(store, 'tok-fail')).toThrow(/ENOSPC/)
  })

  it('persists background attempts through the fsync writer and surfaces failures', () => {
    const path = backgroundAgentLaunchStorePath(dir)
    const store = new BackgroundAgentLaunchStore()
    initBackgroundAgentLaunchStorePersistence(store, path)

    mutateBackgroundStore(store, '0199f7a1-0000-7000-8000-0000000000d1')
    expect(durableWrites).toContain(path)
    expect(plainWrites).not.toContain(path)

    failingWritePaths.add(path)
    expect(() => mutateBackgroundStore(store, '0199f7a1-0000-7000-8000-0000000000d2')).toThrow(
      /ENOSPC/
    )
  })
})
