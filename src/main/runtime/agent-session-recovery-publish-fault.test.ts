import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DurableFileWrite from '../durable-file-write'
import {
  agentSessionStoreRevision,
  loadAgentSessionStore,
  saveAgentSessionStore,
  type AgentSessionStoreState
} from './agent-session-record-store-file'
import { AgentSessionStoreTransactionQueue } from './agent-session-store-transaction-queue'

const publishFault = vi.hoisted(() => ({ armed: false }))

vi.mock('../durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableFileWrite>()
  return {
    ...actual,
    renameDurable: async (tmpPath: string, finalPath: string) => {
      if (publishFault.armed) {
        publishFault.armed = false
        throw new Error('simulated death before primary publish')
      }
      return actual.renameDurable(tmpPath, finalPath)
    }
  }
})

let root: string
let storePath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-store-recovery-publish-'))
  storePath = join(root, 'agent-sessions.json')
})

afterEach(async () => {
  publishFault.armed = false
  await rm(root, { recursive: true, force: true })
})

function state(generation: number): AgentSessionStoreState {
  return {
    schemaVersion: 2,
    hostId: 'local',
    records: new Map(),
    operations: new Map(),
    retiredClaimKeys: [{ keyId: `generation-${generation}`, retiredAt: generation }],
    unreadableRecords: new Map()
  }
}

describe('backup recovery publication', () => {
  it('keeps the valid backup when publication fails after a corrupt primary was recovered', async () => {
    await saveAgentSessionStore(storePath, state(1), { primaryStatus: 'unusable-or-absent' })
    await saveAgentSessionStore(storePath, state(2), {
      primaryStatus: 'validated'
    })
    await writeFile(storePath, '{corrupt-primary', 'utf-8')
    const knownGoodBackup = await readFile(`${storePath}.bak`, 'utf-8')

    const recovered = await loadAgentSessionStore(storePath, 'local')
    expect(recovered.recoveredFromBackup).toBe(true)
    expect(recovered.state.retiredClaimKeys[0]?.keyId).toBe('generation-1')
    const queue = AgentSessionStoreTransactionQueue.fromLoadedStore(
      storePath,
      'local',
      recovered,
      agentSessionStoreRevision(recovered.state)
    )

    publishFault.armed = true
    await expect(queue.persistLoadedRewrite()).rejects.toThrow(
      'simulated death before primary publish'
    )

    expect(await readFile(`${storePath}.bak`, 'utf-8')).toBe(knownGoodBackup)
    const afterFault = await loadAgentSessionStore(storePath, 'local')
    expect(afterFault.recoveredFromBackup).toBe(true)
    expect(afterFault.state.retiredClaimKeys[0]?.keyId).toBe('generation-1')
  })
})
