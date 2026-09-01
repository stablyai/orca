// Catalog/reference authoring against the real Store: an ack means the bytes are on
// disk, a refused write is a typed failure, and payload budgets measure the projection
// persistence actually produces (which expands the caller's patch).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => null),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

async function createService(dataFile: string) {
  vi.resetModules()
  const { Store } = await import('../persistence')
  const { AgentCatalogService } = await import('./agent-catalog-service')
  const store = new Store({ dataFile })
  return { store, service: new AgentCatalogService(store) }
}

function readPersisted(dataFile: string): { settings: GlobalSettings } {
  return JSON.parse(readFileSync(dataFile, 'utf-8')) as { settings: GlobalSettings }
}

const CREATE_CODEX = {
  expectedRevision: 1,
  mutation: {
    kind: 'create' as const,
    baseAgent: 'codex' as const,
    draft: {
      label: 'Durable',
      commandOverride: null,
      args: '',
      env: {},
      syncEnv: false
    }
  }
}

describe('durable catalog authoring through the real Store', () => {
  let dir = ''
  let dataFile = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-agent-catalog-durable-'))
    testState.dir = dir
    dataFile = join(dir, 'orca-data.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('has the created agent on disk before the mutation returns ok', async () => {
    const { service } = await createService(dataFile)
    const result = service.mutate(CREATE_CODEX)
    expect(result.ok).toBe(true)
    // No debounce wait, no flush: the ack itself is the durability barrier.
    expect(readPersisted(dataFile).settings.customTuiAgents).toHaveLength(1)
  })

  it('has the tombstoned deletion on disk before the mutation returns ok', async () => {
    const { service, store } = await createService(dataFile)
    const created = service.mutate(CREATE_CODEX)
    expect(created.ok).toBe(true)
    const [persistedAgent] = store.getSettings().customTuiAgents ?? []
    const deleted = service.mutate({
      expectedRevision: service.getRevision(),
      mutation: { kind: 'delete-custom', id: persistedAgent.id }
    })
    expect(deleted.ok).toBe(true)
    const persisted = readPersisted(dataFile).settings
    expect(persisted.customTuiAgents).toHaveLength(0)
    expect(persisted.deletedCustomTuiAgents).toHaveLength(1)
  })

  it('reports a typed failure instead of acking when the write cannot land', async () => {
    const { service, store } = await createService(dataFile)
    expect(service.mutate(CREATE_CODEX).ok).toBe(true)
    store.freezeWrites()
    const result = service.mutate({
      expectedRevision: service.getRevision(),
      mutation: {
        kind: 'create',
        baseAgent: 'claude',
        draft: {
          label: 'Lost',
          commandOverride: null,
          args: '',
          env: {},
          syncEnv: false
        }
      }
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'agent_catalog_write_failed'
    })
    // Rolled back: an unacknowledged agent must not linger in memory either.
    expect(store.getSettings().customTuiAgents).toHaveLength(1)
    expect(readPersisted(dataFile).settings.customTuiAgents).toHaveLength(1)
  })

  it('rejects a reference write whose persisted projection expands past 512 KiB', async () => {
    const { service, store } = await createService(dataFile)
    // Under the cap as written; persistence derives legacy commitMessageAi from it,
    // so the projection that ships carries the instructions twice.
    const instructions = 'x'.repeat(300_000)
    const result = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: {
        kind: 'source-control-update',
        changes: { instructionsByOperation: { commitMessage: instructions } }
      }
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'agent_reference_payload_too_large'
    })
    expect(store.getSettings().sourceControlAi?.instructionsByOperation?.commitMessage).not.toBe(
      instructions
    )
  })

  it('keeps a reference write whose persisted projection stays under 512 KiB', async () => {
    const { service, store } = await createService(dataFile)
    const result = service.mutateReferences({
      expectedReferenceRevision: 1,
      mutation: {
        kind: 'source-control-update',
        changes: {
          instructionsByOperation: { commitMessage: 'x'.repeat(1_000) }
        }
      }
    })
    expect(result.ok).toBe(true)
    expect(
      store.getSettings().sourceControlAi?.instructionsByOperation?.commitMessage
    ).toHaveLength(1_000)
    expect(
      readPersisted(dataFile).settings.sourceControlAi?.instructionsByOperation?.commitMessage
    ).toHaveLength(1_000)
  })
})
