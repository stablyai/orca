import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import {
  joinHostModelListingWait,
  isHostModelListingWaitInFlight
} from '../../../shared/host-model-listing-waits'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord
} from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

function record(accountHomePath: string): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId: 'session-1',
    provider: 'grok',
    accountHome: { variable: 'GROK_HOME', path: accountHomePath },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'ws-1',
      workspaceKind: 'git-worktree'
    }
  })
}

function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    origin: 'probe'
  }
}

function selectedHomeFingerprint(path: string): string {
  return agentModelCatalogFingerprint({
    agent: 'grok',
    accountHomeVariable: 'GROK_HOME',
    accountHomePath: path,
    wslDistro: null
  })
}

function discover(
  service: ReturnType<typeof createAgentModelCatalogService>,
  params: Parameters<typeof service.read>[0]
) {
  void service.demand(params)
  return service.read(params)
}

const GROK_HOME = (path: string): { variable: 'GROK_HOME'; path: string } => ({
  variable: 'GROK_HOME',
  path
})

describe('agent model catalog service', () => {
  it('answers unknown and kicks one probe for a session whose key has never listed', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async (_home: AgentSessionAccountHome) => listing('gpt-a'))
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => agentSessionConversationView(record('/homes/a')),
      getRecord: () => record('/homes/a'),
      drivesRecord: () => true,
      resolveAccountHome: async () => GROK_HOME('/homes/selected'),
      probes: { grok: probe }
    })
    expect(await discover(service, { agent: 'grok', sessionId: 'session-1' })).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    // A second read while the probe is in flight must not start another, and a
    // record-scoped read probes the RECORD's pinned home, not the selection.
    await service.read({ agent: 'grok', sessionId: 'session-1', waitForListing: true })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    expect(probe).toHaveBeenCalledWith(
      GROK_HOME('/homes/a'),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    await vi.waitFor(async () => {
      const result = await service.read({
        agent: 'grok',
        sessionId: 'session-1',
        waitForListing: true
      })
      expect(result.origin).toBe('probe')
    })
  })

  it('keeps an unsupported pinned record unknown without probing another account', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async (_home: AgentSessionAccountHome) => listing('gpt-a'))
    // A foreign account-home variable cannot authorize a Codex probe.
    const pinned = { ...record('/x'), accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/x' } }
    const drivesRecord = vi.fn(() => false)
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => agentSessionConversationView(pinned),
      getRecord: () => pinned,
      drivesRecord,
      resolveAccountHome: async () => GROK_HOME('/homes/selected'),
      probes: { grok: probe }
    })

    expect(
      await service.read({ agent: 'grok', sessionId: 'session-1', waitForListing: true })
    ).toEqual({ origin: 'unknown' })

    expect(drivesRecord).toHaveBeenCalledWith(agentSessionConversationView(pinned))
    expect(probe).not.toHaveBeenCalled()
    service.stop()
  })

  it('an account switch with no record reads and prewarms the NEW account, never the old entry', async () => {
    const store = new AgentModelCatalogStore()
    const oldFingerprint = selectedHomeFingerprint('/homes/old')
    store.recordSuccess(oldFingerprint, 'grok', listing('gpt-old'), 'discovery')
    const probe = vi.fn(async () => listing('gpt-new'))
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => undefined,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => GROK_HOME('/homes/new'),
      probes: { grok: probe }
    })
    // The record-less read follows the CURRENT selection: unknown, never gpt-old.
    expect(await discover(service, { agent: 'grok' })).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    expect(probe).toHaveBeenCalledWith(
      GROK_HOME('/homes/new'),
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    )
    await vi.waitFor(async () => {
      const result = await service.read({ agent: 'grok', waitForListing: true })
      expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-new')
    })
    expect(store.get(selectedHomeFingerprint('/homes/new'))!.models[0]!.id).toBe('gpt-new')
    expect(store.get(oldFingerprint)!.models[0]!.id).toBe('gpt-old')
  })

  it('a record-less read serves the selected account entry when it exists', async () => {
    const store = new AgentModelCatalogStore()
    store.recordSuccess(
      selectedHomeFingerprint('/homes/selected'),
      'grok',
      listing('gpt-mine'),
      'discovery'
    )
    store.recordSuccess(
      selectedHomeFingerprint('/homes/other'),
      'grok',
      listing('gpt-other'),
      'discovery'
    )
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => undefined,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => GROK_HOME('/homes/selected')
    })
    const result = await service.read({ agent: 'grok', waitForListing: true })
    expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-mine')
  })

  it('a session record outranks the current selection for its own reads', async () => {
    const store = new AgentModelCatalogStore()
    const sessionRecord = record('/homes/session')
    store.recordSuccess(
      agentModelCatalogFingerprintForRecord(sessionRecord),
      'grok',
      listing('gpt-session'),
      'discovery'
    )
    store.recordSuccess(
      selectedHomeFingerprint('/homes/selected'),
      'grok',
      listing('gpt-selected'),
      'discovery'
    )
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => agentSessionConversationView(sessionRecord),
      getRecord: () => sessionRecord,
      drivesRecord: () => true,
      resolveAccountHome: async () => GROK_HOME('/homes/selected')
    })
    const result = await service.read({
      agent: 'grok',
      sessionId: 'session-1',
      waitForListing: true
    })
    expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-session')
  })

  it('a probe failure is a TTL-bounded fact, never an answer', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async () => {
      throw new Error('spawn failed')
    })
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => agentSessionConversationView(record('/homes/a')),
      getRecord: () => record('/homes/a'),
      drivesRecord: () => true,
      resolveAccountHome: async () => GROK_HOME('/homes/a'),
      probes: { grok: probe }
    })
    expect(await discover(service, { agent: 'grok', sessionId: 'session-1' })).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    // Still a clean unknown — and the failure TTL suppresses a probe storm.
    expect(
      await service.read({ agent: 'grok', sessionId: 'session-1', waitForListing: true })
    ).toEqual({
      origin: 'unknown'
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('a failed account-home resolution answers unknown without probing', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(async () => listing('gpt-a'))
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => undefined,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => {
        throw new Error('no store yet')
      },
      probes: { grok: probe }
    })
    expect(await service.read({ agent: 'grok', waitForListing: true })).toEqual({
      origin: 'unknown'
    })
    expect(probe).not.toHaveBeenCalled()
  })

  describe('a read that waits for the first listing', () => {
    function deferredListing() {
      let resolve!: (success: AgentModelCatalogSuccess) => void
      let reject!: (error: Error) => void
      const promise = new Promise<AgentModelCatalogSuccess>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    function coldService(
      probe: (home: AgentSessionAccountHome) => Promise<AgentModelCatalogSuccess>
    ) {
      const store = new AgentModelCatalogStore()
      const service = createAgentModelCatalogService({
        store,
        getConversation: () => undefined,
        getRecord: () => record('/homes/selected'),
        drivesRecord: () => true,
        resolveAccountHome: async () => GROK_HOME('/homes/selected'),
        probes: { grok: probe }
      })
      return { store, service }
    }

    it('joins the listing the first read started and answers with it', async () => {
      const pending = deferredListing()
      const probe = vi.fn(() => pending.promise)
      const { service } = coldService(probe)
      expect(await discover(service, { agent: 'grok' })).toEqual({
        origin: 'unknown',
        listingInProgress: true
      })
      const waited = service.read({ agent: 'grok', waitForListing: true })
      pending.resolve(listing('gpt-listed'))
      const result = await waited
      expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-listed')
      expect(probe).toHaveBeenCalledTimes(1)
    })

    it('publishes a real live listing beside a held probe and preserves probe failure', async () => {
      const pendingProbe = deferredListing()
      const { store, service } = coldService(() => pendingProbe.promise)
      const fingerprint = selectedHomeFingerprint('/homes/selected')
      try {
        await discover(service, { agent: 'grok' })
        await vi.waitFor(() => expect(store.isListing(fingerprint)).toBe(true))
        const terminal = store.pendingListing(fingerprint, true, true)
        const waited = service.read({ agent: 'grok', waitForListing: true })
        service.recordLiveListing('session-1', { models: listing('gpt-chat').models })
        expect(await waited).toMatchObject({ origin: 'live-session', models: [{ id: 'gpt-chat' }] })
        expect(store.isListing(fingerprint)).toBe(true)
        pendingProbe.reject(new Error('probe timed out'))
        await terminal
        expect(store.failureDetail(fingerprint)).toBe('probe timed out')
        service.recordLiveListing('session-1', { models: listing('gpt-new-chat').models })
        expect(store.get(fingerprint)?.models[0]?.id).toBe('gpt-new-chat')
        expect(store.hasActiveFailure(fingerprint)).toBe(true)
      } finally {
        service.stop()
      }
    })

    it('answers a plain unknown when the listing fails', async () => {
      const pending = deferredListing()
      const { service } = coldService(() => pending.promise)
      const waited = service.read({ agent: 'grok', waitForListing: true })
      pending.reject(new Error('spawn failed'))
      expect(await waited).toEqual({ origin: 'unknown' })
    })

    it('does not wait or report a listing while a failure is inside its TTL', async () => {
      const probe = vi.fn(async (): Promise<AgentModelCatalogSuccess> => {
        throw new Error('spawn failed')
      })
      const { store, service } = coldService(probe)
      await store.refresh(selectedHomeFingerprint('/homes/selected'), 'grok', () =>
        Promise.reject(new Error('spawn failed'))
      )
      expect(await service.read({ agent: 'grok', waitForListing: true })).toEqual({
        origin: 'unknown'
      })
      expect(await service.read({ agent: 'grok', waitForListing: true })).toEqual({
        origin: 'unknown'
      })
      expect(probe).not.toHaveBeenCalled()
    })

    it('reports no listing where the host has no lister for the account', async () => {
      const store = new AgentModelCatalogStore()
      const service = createAgentModelCatalogService({
        store,
        getConversation: () => undefined,
        getRecord: () => undefined,
        drivesRecord: () => true,
        resolveAccountHome: async () => GROK_HOME('/homes/selected')
      })
      expect(await service.read({ agent: 'grok', waitForListing: true })).toEqual({
        origin: 'unknown'
      })
    })

    it('serves an aged entry at once and refreshes it behind the answer', async () => {
      let now = 0
      const store = new AgentModelCatalogStore({ now: () => now })
      store.recordSuccess(
        selectedHomeFingerprint('/homes/selected'),
        'grok',
        listing('gpt-old'),
        'discovery'
      )
      now = AGENT_MODEL_CATALOG_FRESH_MS
      const probe = vi.fn(() => new Promise<AgentModelCatalogSuccess>(() => {}))
      const service = createAgentModelCatalogService({
        store,
        getConversation: () => undefined,
        getRecord: () => undefined,
        drivesRecord: () => true,
        resolveAccountHome: async () => GROK_HOME('/homes/selected'),
        probes: { grok: probe }
      })
      const result = await service.read({ agent: 'grok', waitForListing: true })
      expect(result.origin === 'unknown' ? null : result.models[0]!.id).toBe('gpt-old')
      expect(probe).toHaveBeenCalledTimes(1)
    })
  })

  describe('a read for the workspace a new chat runs in', () => {
    function serviceWith(mayOverride: boolean) {
      const store = new AgentModelCatalogStore()
      store.recordSuccess(
        selectedHomeFingerprint('/homes/selected'),
        'grok',
        listing('gpt-user'),
        'discovery'
      )
      const workspaceMayOverrideDefaultModel = vi.fn(async () => mayOverride)
      const service = createAgentModelCatalogService({
        store,
        getConversation: () => undefined,
        getRecord: () => undefined,
        drivesRecord: () => true,
        resolveAccountHome: async () => GROK_HOME('/homes/selected'),
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
      const result = await service.read({
        agent: 'grok',
        waitForListing: true,
        workspacePath: '/repo/wt'
      })
      expect(defaults(result)).toEqual([false])
      expect(workspaceMayOverrideDefaultModel).toHaveBeenCalledWith({
        agent: 'grok',
        workspacePath: '/repo/wt',
        accountHomePath: '/homes/selected'
      })
    })

    it('keeps the listed default when nothing in the workspace can replace it', async () => {
      const { service } = serviceWith(false)
      expect(
        defaults(
          await service.read({ agent: 'grok', waitForListing: true, workspacePath: '/repo/wt' })
        )
      ).toEqual([true])
    })

    it('names no default for a workspace it could not place on this machine', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(false)
      expect(
        defaults(await service.read({ agent: 'grok', waitForListing: true, workspacePath: null }))
      ).toEqual([false])
      expect(workspaceMayOverrideDefaultModel).not.toHaveBeenCalled()
    })

    it('leaves a read that names no workspace as it was', async () => {
      const { service, workspaceMayOverrideDefaultModel } = serviceWith(true)
      expect(defaults(await service.read({ agent: 'grok', waitForListing: true }))).toEqual([true])
      expect(workspaceMayOverrideDefaultModel).not.toHaveBeenCalled()
    })
  })

  describe('an agent whose account is not one directory', () => {
    const managed = (id: string): AgentSessionAccountHome => ({
      kind: 'opencode',
      locator: { kind: 'managed', managedProfileId: id }
    })
    const PROFILE_A = '0b0c6f5e-4f51-4c4a-9d3e-1a2b3c4d5e6f'
    const PROFILE_B = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f'
    const openCodeRecord = (
      home: AgentSessionAccountHome,
      wslDistro: string | null = null
    ): AgentSessionRecord => ({
      ...record('/unused'),
      provider: 'opencode',
      accountHome: home,
      location: { ...record('/unused').location, wslDistro }
    })

    it('probes under the account the chat pinned, and keeps each account’s listing apart', async () => {
      const store = new AgentModelCatalogStore()
      const probe = vi.fn(async (home: AgentSessionAccountHome) => listing(JSON.stringify(home)))
      const service = createAgentModelCatalogService({
        store,
        getConversation: () => agentSessionConversationView(openCodeRecord(managed(PROFILE_A))),
        getRecord: () => openCodeRecord(managed(PROFILE_A)),
        drivesRecord: () => true,
        resolveAccountHome: async () => managed(PROFILE_B),
        probes: { opencode: probe }
      })
      await service.read({ agent: 'opencode', sessionId: 'session-1', waitForListing: true })
      await service.read({ agent: 'opencode', waitForListing: true })
      expect(probe.mock.calls.map(([home]) => home)).toEqual([
        managed(PROFILE_A),
        managed(PROFILE_B)
      ])
      const pinned = await service.read({ agent: 'opencode', sessionId: 'session-1' })
      const selected = await service.read({ agent: 'opencode' })
      expect(pinned.origin !== 'unknown' && pinned.models[0]!.id).toContain(PROFILE_A)
      expect(selected.origin !== 'unknown' && selected.models[0]!.id).toContain(PROFILE_B)
    })

    it('starts no host-side probe for a chat pinned inside WSL', async () => {
      const probe = vi.fn(async () => listing('never'))
      const service = createAgentModelCatalogService({
        store: new AgentModelCatalogStore(),
        getConversation: () =>
          agentSessionConversationView(openCodeRecord(managed(PROFILE_A), 'Ubuntu')),
        getRecord: () => openCodeRecord(managed(PROFILE_A), 'Ubuntu'),
        drivesRecord: () => true,
        resolveAccountHome: async () => managed(PROFILE_B),
        probes: { opencode: probe }
      })
      expect(
        await service.read({ agent: 'opencode', sessionId: 'session-1', waitForListing: true })
      ).toEqual({
        origin: 'unknown'
      })
      expect(probe).not.toHaveBeenCalled()
    })
  })
})

it.each(['cold', 'warm'] as const)(
  'ends queued %s discovery within its original deadline and preserves existing observations',
  async (mode) => {
    vi.useFakeTimers()
    const store = new AgentModelCatalogStore()
    let failing = false
    const run = vi.fn(
      (
        _home: AgentSessionAccountHome,
        options?: { signal?: AbortSignal; workspacePath?: string }
      ) =>
        new Promise<AgentModelCatalogSuccess>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              failing
                ? reject(new Error('offline'))
                : resolve({
                    ...listing(options?.workspacePath ?? 'listed'),
                    complete: true,
                    configured: {}
                  }),
            12_000
          )
          options?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('stopped'))
            },
            { once: true }
          )
        })
    )
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => undefined,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/account' }),
      probes: { codex: run }
    })
    const read = (path: string, waitForListing = false) =>
      waitForListing
        ? service.read({ agent: 'codex', workspacePath: path, waitForListing })
        : discover(service, { agent: 'codex', workspacePath: path })
    const replies: unknown[] = []
    let leave = () => {}
    try {
      if (mode === 'warm') {
        const initial = read('/5', true)
        await vi.advanceTimersByTimeAsync(12_000)
        await initial
        await vi.advanceTimersByTimeAsync(120_001)
      }
      failing = false
      await Promise.all(['/1', '/2', '/3', '/4', '/5'].map((path) => read(path)))
      const follow = vi.fn(() => read('/5', true))
      const owner = { close() {} }
      leave = joinHostModelListingWait('queued', follow, (reply) => replies.push(reply), owner)
      const second = joinHostModelListingWait('queued', follow, () => {}, owner)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(replies[0]).not.toHaveProperty('listingInProgress')
      expect(follow).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(7_000)
      expect(replies.at(-1)).not.toHaveProperty('listingInProgress')
      expect(isHostModelListingWaitInFlight('queued', owner)).toBe(false)
      if (mode === 'warm') {
        expect(replies.at(-1)).toMatchObject({ models: [{ id: '/5' }] })
      } else {
        expect(replies.at(-1)).toEqual({ origin: 'unknown' })
      }
      expect(run).toHaveBeenCalledTimes(mode === 'warm' ? 6 : 5)
      second()
    } finally {
      leave()
      service.stop()
      vi.useRealTimers()
    }
  }
)

it.each(['opencode', 'opencode2', 'omp'] as const)(
  'keeps %s session-folder requests separate for explicit and historical readers',
  async (agent) => {
    const records = new Map(
      ['w1', 'w2'].map((id) => [
        id,
        {
          ...record('/same-account'),
          sessionId: id,
          provider: agent,
          location: { ...record('/same-account').location, workspaceId: id }
        }
      ])
    )
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(
      async (_home: AgentSessionAccountHome, options?: { workspacePath?: string }) =>
        listing(options?.workspacePath ?? 'account')
    )
    const service = createAgentModelCatalogService({
      store,
      getConversation: (id) => {
        const held = records.get(id)
        return held ? agentSessionConversationView(held) : undefined
      },
      getRecord: (id) => records.get(id),
      drivesRecord: () => true,
      resolveAccountHome: async () => GROK_HOME('/same-account'),
      recordWorkspacePath: async (row) => `/${row.location.workspaceId}`,
      listsInChatFolder: new Set([agent]),
      probes: { [agent]: probe }
    })
    try {
      for (const inSessionWorkspace of [true, undefined] as const) {
        const params = (sessionId: string) => ({
          agent,
          sessionId,
          ...(inSessionWorkspace ? { inSessionWorkspace } : {})
        })
        await service.demand(params('w1'))
        expect(service.snapshot(params('w1'))).toMatchObject({ models: [{ id: '/w1' }] })
        if (inSessionWorkspace) {
          expect(service.snapshot(params('w2'))).toEqual({ origin: 'unknown' })
        } else {
          expect(service.snapshot(params('w2'))).toMatchObject({ models: [{ id: '/w2' }] })
        }
        await service.prepareSaved(params('w2'))
        await service.demand(params('w2'))
        expect(service.snapshot(params('w2'))).toMatchObject({ models: [{ id: '/w2' }] })
      }
    } finally {
      service.stop()
    }
  }
)

it('shares account rows while keeping workspace default provenance separate', async () => {
  const store = new AgentModelCatalogStore()
  const records = new Map(
    ['w1', 'w2'].map((id) => [
      id,
      {
        ...record('/same-account'),
        sessionId: id,
        provider: 'pi',
        location: { ...record('/same-account').location, workspaceId: id }
      }
    ])
  )
  const first = records.get('w1')!
  store.recordSuccess(
    agentModelCatalogFingerprintForRecord(first),
    'pi',
    listing('account-default'),
    'discovery'
  )
  const service = createAgentModelCatalogService({
    store,
    getConversation: (id) => {
      const held = records.get(id)
      return held ? agentSessionConversationView(held) : undefined
    },
    getRecord: (id) => records.get(id),
    drivesRecord: () => true,
    resolveAccountHome: async () => first.accountHome,
    recordWorkspacePath: async (row) => `/${row.location.workspaceId}`,
    agentReadsProjectModelConfig: () => true,
    workspaceMayOverrideDefaultModel: async ({ workspacePath }) => workspacePath === '/w2'
  })
  try {
    const one = { agent: 'pi', sessionId: 'w1', inSessionWorkspace: true as const }
    const two = { ...one, sessionId: 'w2' }
    expect(await service.prepareSaved(one)).toMatchObject({
      models: [{ id: 'account-default', isDefault: true }]
    })
    expect(service.snapshot(two)).toEqual({ origin: 'unknown' })
    expect(await service.prepareSaved(two)).toMatchObject({
      models: [{ id: 'account-default', isDefault: false }]
    })
    expect(service.snapshot(one)).toMatchObject({ models: [{ isDefault: true }] })
  } finally {
    service.stop()
  }
})

it.each(['pi', 'grok'])(
  '%s applies live publication policy to both inventory and configured defaults',
  async (agent) => {
    const saved = agentSessionRecordFixture({
      ...record('/same-account'),
      provider: agent,
      accountHome: {
        variable: agent === 'pi' ? 'PI_CODING_AGENT_DIR' : 'GROK_HOME',
        path: '/same-account'
      }
    })
    const store = new AgentModelCatalogStore()
    const fingerprint = agentModelCatalogFingerprintForRecord(saved)
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => saved,
      getConversation: () => agentSessionConversationView(saved),
      drivesRecord: () => true,
      resolveAccountHome: async () => saved.accountHome,
      recordWorkspacePath: async () => '/workspace',
      workspaceMayOverrideDefaultModel: async () => false
    })
    onTestFinished(() => service.stop())
    const defaultWrite = vi.spyOn(store, 'recordConfiguredDefault')
    const inventoryWrite = vi.spyOn(store, 'recordSuccess')
    const publish = (id: string) =>
      service.recordLiveListing(saved.sessionId, {
        models: listing(id).models,
        configuredDefault: { modelId: id, effort: 'high' }
      })
    publish('first')
    if (agent === 'pi') {
      await Promise.resolve()
      expect(inventoryWrite).not.toHaveBeenCalled()
      expect(defaultWrite).not.toHaveBeenCalled()
      expect(store.get(fingerprint)).toBeNull()
    } else {
      await vi.waitFor(() => expect(store.get(fingerprint)?.configured?.modelId).toBe('first'))
    }
    store.recordSuccess(fingerprint, agent, listing('account'), 'discovery')
    const good = store.get(fingerprint)
    publish('late-project')
    service.recordLiveListing(saved.sessionId, {
      models: listing('late-project').models,
      configuredDefault: null
    })
    if (agent === 'pi') {
      await Promise.resolve()
      expect(store.get(fingerprint)).toBe(good)
      expect(defaultWrite).not.toHaveBeenCalled()
      expect(inventoryWrite).toHaveBeenCalledOnce()
    } else {
      await vi.waitFor(() => expect(store.get(fingerprint)?.configured).toBeNull())
      expect(store.get(fingerprint)?.models[0]?.id).toBe('late-project')
      expect(defaultWrite).toHaveBeenCalledTimes(3)
    }
    await store.refresh(fingerprint, agent, async () => {
      throw new Error('probe failed')
    })
    expect(store.hasActiveFailure(fingerprint)).toBe(true)
    service.providerStarted(saved)
    await vi.waitFor(() => expect(store.hasActiveFailure(fingerprint)).toBe(false))
  }
)
