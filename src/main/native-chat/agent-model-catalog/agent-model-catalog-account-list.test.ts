import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

const HOME = { variable: 'CODEX_HOME', path: '/account' }
const FOLDERS: Record<string, string> = { a: '/project-a', b: '/project-b', r: '/restricted' }

const listing = (ids: string[], model?: string): AgentModelCatalogSuccess => ({
  origin: 'probe',
  complete: true,
  models: ids.map((id) => ({ id, label: id, isDefault: id === ids[0], efforts: [] })),
  configured: model ? { model } : {}
})

function record(sessionId: string): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: HOME,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: sessionId,
      workspaceKind: 'folder'
    }
  })
}

function harness() {
  const full = ['gpt-a', 'gpt-b', 'gpt-c']
  const byFolder: Record<string, AgentModelCatalogSuccess> = {
    [homedir()]: listing(full),
    '/project-a': listing(full, 'gpt-b'),
    '/project-b': listing(full, 'gpt-c'),
    '/restricted': listing(['local-only'], 'local-only')
  }
  const gates = new Map<string, PromiseWithResolvers<void>>()
  const runs: string[] = []
  const resolve = vi.fn(async (_home: unknown, cwd: string) => ({
    identity: { command: 'codex', cwd },
    run: async () => {
      runs.push(cwd)
      await gates.get(cwd)?.promise
      return byFolder[cwd]
    }
  }))
  const probe: AgentModelCatalogProbe = Object.assign(async () => byFolder[homedir()], { resolve })
  const service = createAgentModelCatalogService({
    store: new AgentModelCatalogStore({ now: () => 1000 }),
    getConversation: (id) => agentSessionConversationView(record(id)),
    getRecord: record,
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME,
    recordWorkspacePath: async (saved) => FOLDERS[saved.sessionId] ?? null,
    workspaceMayOverrideDefaultModel: async () => false,
    probes: { codex: probe }
  })
  const hold = (folder: string): (() => void) => {
    const gate = Promise.withResolvers<void>()
    gates.set(folder, gate)
    return () => gate.resolve()
  }
  const read = (sessionId: string, extra = {}) =>
    service.read({ agent: 'codex', sessionId, ...extra })
  return { service, runs, hold, read, full }
}

const ids = (result: Awaited<ReturnType<ReturnType<typeof harness>['read']>>) =>
  result.origin === 'unknown' ? null : result.models.map((model) => model.id)

describe('account model list for folders not yet listed', () => {
  it('shows the account list at once in a new folder, then the folder’s own listing', async () => {
    const h = harness()
    await h.service.read({ agent: 'codex', waitForListing: true })
    await vi.waitFor(() => expect(h.runs).toEqual([homedir()]))
    const release = h.hold('/project-a')
    void h.service.demand({ agent: 'codex', sessionId: 'a' })
    const first = await h.read('a')
    expect(ids(first)).toEqual(h.full)
    // The account list stands in for the folder's; it names no default as the folder's own.
    expect(first).toMatchObject({ listingInProgress: true })
    expect(first.origin !== 'unknown' && first.models.some((model) => model.isDefault)).toBe(false)
    release()
    const settled = await h.read('a', { waitForListing: true })
    expect(ids(settled)).toEqual(h.full)
    expect(settled).not.toHaveProperty('listingInProgress')
    expect(settled.origin !== 'unknown' && settled.models.find((m) => m.isDefault)?.id).toBe(
      'gpt-b'
    )
    h.service.stop()
  })

  it('never seeds other folders from a folder’s own listing', async () => {
    const h = harness()
    await h.read('r', { waitForListing: true })
    expect(h.runs).toEqual(['/restricted'])
    const release = h.hold('/project-b')
    void h.service.demand({ agent: 'codex', sessionId: 'b' })
    expect(ids(await h.read('b'))).toBeNull()
    await h.service.read({ agent: 'codex', waitForListing: true })
    await vi.waitFor(async () => expect(ids(await h.read('b'))).toEqual(h.full))
    release()
    h.service.stop()
  })
})
