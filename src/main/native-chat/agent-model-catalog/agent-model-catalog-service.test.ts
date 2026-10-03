import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord
} from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore, type AgentModelCatalogSuccess } from './agent-model-catalog-store'

function record(accountHomePath: string): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only provider, accountHome and location; the rest of the record is irrelevant here.
  return {
    sessionId: 'session-1',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: accountHomePath },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'ws-1',
      workspaceKind: 'git-worktree'
    }
  } as AgentSessionRecord
}

function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    fastModeTierByModel: new Map(),
    origin: 'probe'
  }
}

function selectedHomeFingerprint(path: string): string {
  return agentModelCatalogFingerprint({
    agent: 'codex',
    accountHomeVariable: 'CODEX_HOME',
    accountHomePath: path,
    wslDistro: null
  })
}

const CODEX_HOME = (path: string): { variable: 'CODEX_HOME'; path: string } => ({
  variable: 'CODEX_HOME',
  path
})

describe('agent model catalog service', () => {
  it('answers unknown and kicks one probe for a session whose key has never listed', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async (_home: string) => listing('gpt-a'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => record('/homes/a'),
      resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
      probes: { codex: probe }
    })
    expect(await service.read({ agent: 'codex', sessionId: 'session-1' })).toEqual({
      origin: 'unknown'
    })
    // A second read while the probe is in flight must not start another, and a
    // record-scoped read probes the RECORD's pinned home, not the selection.
    await service.read({ agent: 'codex', sessionId: 'session-1' })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith('/homes/a')
    await vi.waitFor(async () => {
      const result = await service.read({ agent: 'codex', sessionId: 'session-1' })
      expect(result.origin).toBe('probe')
    })
  })

  it('an account switch with no record reads and prewarms the NEW account, never the old entry', async () => {
    const store = new AgentModelCatalogStore()
    // The old account listed under its own fingerprint before the switch.
    const oldFingerprint = selectedHomeFingerprint('/homes/old')
    store.recordSuccess(oldFingerprint, 'codex', listing('gpt-old'))
    const probe = vi.fn(async () => listing('gpt-new'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      resolveAccountHome: async () => CODEX_HOME('/homes/new'),
      probes: { codex: probe }
    })
    // The record-less read follows the CURRENT selection: unknown, never gpt-old.
    expect(await service.read({ agent: 'codex' })).toEqual({ origin: 'unknown' })
    expect(probe).toHaveBeenCalledWith('/homes/new')
    await vi.waitFor(async () => {
      const result = await service.read({ agent: 'codex' })
      expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-new')
    })
    // The new listing landed under the new selection's key; the old entry is untouched.
    expect(store.get(selectedHomeFingerprint('/homes/new'))!.models[0]!.id).toBe('gpt-new')
    expect(store.get(oldFingerprint)!.models[0]!.id).toBe('gpt-old')
  })

  it('a record-less read serves the selected account entry when it exists', async () => {
    const store = new AgentModelCatalogStore()
    store.recordSuccess(selectedHomeFingerprint('/homes/selected'), 'codex', listing('gpt-mine'))
    store.recordSuccess(selectedHomeFingerprint('/homes/other'), 'codex', listing('gpt-other'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      resolveAccountHome: async () => CODEX_HOME('/homes/selected')
    })
    const result = await service.read({ agent: 'codex' })
    expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-mine')
  })

  it('a session record outranks the current selection for its own reads', async () => {
    const store = new AgentModelCatalogStore()
    const sessionRecord = record('/homes/session')
    store.recordSuccess(
      agentModelCatalogFingerprintForRecord(sessionRecord),
      'codex',
      listing('gpt-session')
    )
    store.recordSuccess(
      selectedHomeFingerprint('/homes/selected'),
      'codex',
      listing('gpt-selected')
    )
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => sessionRecord,
      resolveAccountHome: async () => CODEX_HOME('/homes/selected')
    })
    const result = await service.read({ agent: 'codex', sessionId: 'session-1' })
    expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-session')
  })

  it('a probe failure is a TTL-bounded fact, never an answer', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async () => {
      throw new Error('spawn failed')
    })
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => record('/homes/a'),
      resolveAccountHome: async () => CODEX_HOME('/homes/a'),
      probes: { codex: probe }
    })
    expect(await service.read({ agent: 'codex', sessionId: 'session-1' })).toEqual({
      origin: 'unknown'
    })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    // Still a clean unknown — and the failure TTL suppresses a probe storm.
    expect(await service.read({ agent: 'codex', sessionId: 'session-1' })).toEqual({
      origin: 'unknown'
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('a failed account-home resolution answers unknown without probing', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async () => listing('gpt-a'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      resolveAccountHome: async () => {
        throw new Error('no store yet')
      },
      probes: { codex: probe }
    })
    expect(await service.read({ agent: 'codex' })).toEqual({ origin: 'unknown' })
    expect(probe).not.toHaveBeenCalled()
  })

  describe('a read for the workspace a new chat runs in', () => {
    function serviceWith(mayOverride: boolean) {
      const store = new AgentModelCatalogStore()
      store.recordSuccess(selectedHomeFingerprint('/homes/selected'), 'codex', listing('gpt-user'))
      const workspaceMayOverrideDefaultModel = vi.fn(async () => mayOverride)
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => undefined,
        resolveAccountHome: async () => CODEX_HOME('/homes/selected'),
        workspaceMayOverrideDefaultModel
      })
      return { service, workspaceMayOverrideDefaultModel }
    }

    function defaults(
      result: Awaited<ReturnType<ReturnType<typeof serviceWith>['service']['read']>>
    ) {
      return result.origin === 'unknown' ? null : result.models.map((model) => model.isDefault)
    }

    it('names no default when the workspace config could pick another model', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(true)
      const result = await service.read({ agent: 'codex', workspacePath: '/repo/wt' })
      expect(defaults(result)).toEqual([false])
      expect(workspaceMayOverrideDefaultModel).toHaveBeenCalledWith({
        agent: 'codex',
        workspacePath: '/repo/wt',
        accountHomePath: '/homes/selected'
      })
    })

    it('keeps the listed default when nothing in the workspace can replace it', async () => {
      const { service } = serviceWith(false)
      expect(defaults(await service.read({ agent: 'codex', workspacePath: '/repo/wt' }))).toEqual([
        true
      ])
    })

    it('names no default for a workspace it could not place on this machine', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(false)
      expect(defaults(await service.read({ agent: 'codex', workspacePath: null }))).toEqual([false])
      expect(workspaceMayOverrideDefaultModel).not.toHaveBeenCalled()
    })

    it('leaves a read that names no workspace as it was', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(true)
      expect(defaults(await service.read({ agent: 'codex' }))).toEqual([true])
      expect(workspaceMayOverrideDefaultModel).not.toHaveBeenCalled()
    })
  })
})
