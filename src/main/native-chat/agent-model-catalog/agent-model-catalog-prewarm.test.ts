import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { describe, expect, it, vi } from 'vitest'

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprintForRecord,
  agentModelCatalogSessionAccess
} from './agent-model-catalog-fingerprint'
import { AgentModelCatalogListingStoppedError } from './agent-model-catalog-failures'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

const spans = vi.hoisted(() => {
  const started: { name: string; attributes: Record<string, unknown>; outcome: string }[] = []
  return { started }
})

vi.mock('../../observability/tracer', () => ({
  startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) => {
    const span = { name, attributes: { ...options?.attributes }, outcome: 'open' }
    spans.started.push(span)
    return {
      setAttribute: (key: string, value: unknown) => {
        span.attributes[key] = value
      },
      end: () => {
        span.outcome = 'ok'
      },
      fail: () => {
        span.outcome = 'failed'
      }
    }
  }
}))
function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    origin: 'probe',
    complete: true
  }
}

const HOME = (variable: string, path: string): AgentSessionAccountHome => ({ variable, path })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('model catalog prewarm', () => {
  it('lists every agent once for the account a new chat would pin, and joins a read meanwhile', async () => {
    let now = 0
    const store = new AgentModelCatalogStore({ now: () => now })
    const codexListed = deferred<AgentModelCatalogSuccess>()
    const codex = vi.fn(async (_home: AgentSessionAccountHome) => codexListed.promise)
    const grok = vi.fn(async (_home: AgentSessionAccountHome) => listing('grok-4'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      hasChatRecords: () => true,
      resolveAccountHome: async (agent) =>
        agent === 'codex' ? HOME('CODEX_HOME', '/homes/a') : HOME('GROK_HOME', '/grok'),
      probes: { codex, grok }
    })

    const prewarmed = service.prewarm()
    await vi.waitFor(() => expect(codex).toHaveBeenCalledTimes(1))
    // A picker opening while the prewarm lists joins it instead of spawning a second listing.
    expect(await service.read({ agent: 'codex' })).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    codexListed.resolve(listing('gpt-a'))
    await prewarmed

    expect(codex).toHaveBeenCalledTimes(1)
    expect(codex).toHaveBeenCalledWith(HOME('CODEX_HOME', '/homes/a'), {
      workspacePath: expect.any(String),
      signal: expect.any(AbortSignal)
    })
    expect(grok).toHaveBeenCalledTimes(1)
    expect((await service.read({ agent: 'codex' })).origin).toBe('probe')
    expect((await service.read({ agent: 'grok' })).origin).toBe('probe')

    // Fresh: a second prewarm lists nothing; once old, it lists again.
    await service.prewarm()
    expect(codex).toHaveBeenCalledTimes(1)
    now += AGENT_MODEL_CATALOG_FRESH_MS
    await service.prewarm()
    expect(codex).toHaveBeenCalledTimes(2)
    expect(grok).toHaveBeenCalledTimes(2)
  })

  // A project's opencode.json can add or remove models, so its folder keeps its own list.
  // The folder lookup can answer the earlier report last; the later report must still win.
  it("saves a running chat's reports in the order it sent them, per folder", async () => {
    const store = new AgentModelCatalogStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only provider, accountHome, location and launchDirectory.
    const chat = {
      sessionId: 'chat-b',
      provider: 'opencode2',
      accountHome: HOME('OPENCODE_HOME', '/homes/a'),
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'ws-b',
        workspaceKind: 'folder'
      }
    } as AgentSessionRecord
    const lookups = [deferred<string | null>(), deferred<string | null>()]
    let lookup = 0
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => chat,
      drivesRecord: () => true,
      resolveAccountHome: async () => HOME('OPENCODE_HOME', '/homes/a'),
      listsInChatFolder: new Set(['opencode2']),
      recordWorkspacePath: () => lookups[lookup++]?.promise ?? Promise.resolve('/work/b')
    })
    service.recordLiveListing('chat-b', { models: listing('older').models })
    service.recordLiveListing('chat-b', { models: listing('newer').models })
    lookups[1]!.resolve('/work/b')
    lookups[0]!.resolve('/work/b')
    const read = await service.read({ agent: 'opencode2', sessionId: 'chat-b' })
    expect(read.origin !== 'unknown' && read.models.map((model) => model.id)).toEqual(['newer'])
  })

  it('keeps one catalog per folder for an agent whose project config changes its models', async () => {
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(
      async (_home: AgentSessionAccountHome, options?: { workspacePath?: string }) =>
        listing(options?.workspacePath === '/work/b' ? 'only-in-b' : 'big-pickle')
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only provider, accountHome, location and launchDirectory.
    const chatInB = {
      sessionId: 'chat-b',
      provider: 'opencode2',
      accountHome: HOME('OPENCODE_HOME', '/homes/a'),
      launchDirectory: '/work/b',
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'ws-b',
        workspaceKind: 'folder'
      }
    } as AgentSessionRecord
    const service = createAgentModelCatalogService({
      store,
      getRecord: (sessionId) => (sessionId === 'chat-b' ? chatInB : undefined),
      drivesRecord: () => true,
      resolveAccountHome: async () => HOME('OPENCODE_HOME', '/homes/a'),
      probes: { opencode2: probe },
      listsInChatFolder: new Set(['opencode2']),
      recordWorkspacePath: async (record) => record.launchDirectory ?? null
    })
    const ids = async (workspacePath: string) => {
      const read = await service.read({ agent: 'opencode2', workspacePath, waitForListing: true })
      return read.origin === 'unknown' ? [] : read.models.map((model) => model.id)
    }

    // Asked at once, neither folder joins the other's listing.
    expect(await Promise.all([ids('/work/a'), ids('/work/b')])).toEqual([
      ['big-pickle'],
      ['only-in-b']
    ])
    expect(probe.mock.calls.map(([, options]) => options?.workspacePath).sort()).toEqual([
      '/work/a',
      '/work/b'
    ])
    // A chat running in B saves what it lists for B only.
    service.recordLiveListing('chat-b', { models: listing('live-b').models })
    await vi.waitFor(async () => expect(await ids('/work/b')).toEqual(['live-b']))
    expect(await ids('/work/a')).toEqual(['big-pickle'])
    expect(probe).toHaveBeenCalledTimes(2)
    const answer = await service.read({ agent: 'opencode2', workspacePath: '/work/a' })
    expect(answer).toMatchObject({ modelsDifferByWorkspace: true })
  })

  // A picker that joined a prewarm listing with no chat folder was answered nothing at all.
  it('never prewarms a listing that runs in a chat folder, so a picker lists in its own', async () => {
    const store = new AgentModelCatalogStore()
    const versionChecked = deferred<void>()
    const probe = vi.fn(
      async (_home: AgentSessionAccountHome, options?: { workspacePath?: string }) => {
        await versionChecked.promise
        if (!options?.workspacePath) {
          throw new AgentModelCatalogListingStoppedError('lists in a chat folder')
        }
        return listing('big-pickle')
      }
    )
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      hasChatRecords: () => true,
      resolveAccountHome: async () => HOME('OPENCODE_HOME', '/homes/a'),
      probes: { opencode2: probe },
      listsInChatFolder: new Set(['opencode2'])
    })

    const prewarmed = service.prewarm()
    const opened = await service.read({ agent: 'opencode2', workspacePath: '/work/project' })
    const waited = service.read({
      agent: 'opencode2',
      workspacePath: '/work/project',
      waitForListing: true
    })
    versionChecked.resolve()
    await prewarmed
    expect(opened).toEqual({ origin: 'unknown', listingInProgress: true })
    expect((await waited).origin).toBe('probe')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(HOME('OPENCODE_HOME', '/homes/a'), {
      signal: expect.any(AbortSignal),
      workspacePath: '/work/project'
    })
  })

  it('lists the new account after a switch and leaves the old account’s catalog alone', async () => {
    const store = new AgentModelCatalogStore()
    let selected = '/homes/a'
    const probe = vi.fn(async (home: AgentSessionAccountHome) =>
      listing('variable' in home && home.path === '/homes/a' ? 'gpt-a' : 'gpt-b')
    )
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      hasChatRecords: () => true,
      resolveAccountHome: async () => HOME('CODEX_HOME', selected),
      probes: { codex: probe }
    })
    await service.prewarm()
    selected = '/homes/b'
    await service.prewarm()

    expect(probe.mock.calls.map(([home]) => home)).toEqual([
      HOME('CODEX_HOME', '/homes/a'),
      HOME('CODEX_HOME', '/homes/b')
    ])
    const read = await service.read({ agent: 'codex' })
    expect(read.origin !== 'unknown' && read.models.map((model) => model.id)).toEqual(['gpt-b'])
  })

  it('respects the failure back-off and skips an agent whose account cannot be resolved', async () => {
    const store = new AgentModelCatalogStore()
    const codex = vi.fn(
      async (_home: AgentSessionAccountHome): Promise<AgentModelCatalogSuccess> => {
        throw new Error('spawn codex ENOENT')
      }
    )
    const claude = vi.fn(async (_home: AgentSessionAccountHome) => listing('opus'))
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      hasChatRecords: () => true,
      resolveAccountHome: async (agent) => {
        if (agent === 'claude') {
          throw new Error('account home unreadable')
        }
        return HOME('CODEX_HOME', '/homes/a')
      },
      probes: { codex, claude }
    })
    spans.started.length = 0
    await service.prewarm()
    await service.prewarm()
    expect(codex).toHaveBeenCalledTimes(1)
    expect(claude).not.toHaveBeenCalled()
    // Each listing leaves its agent and outcome in the trace log; the span carries its duration.
    expect(spans.started).toEqual([
      {
        name: 'agentModelCatalog.discovery',
        attributes: { agent: 'codex', lister: 'probe' },
        outcome: 'failed'
      }
    ])
  })

  it('lists only agents used here: a saved catalog or a chat of it', async () => {
    const store = new AgentModelCatalogStore()
    const probeFor = (agent: string) =>
      vi.fn(async (_home: AgentSessionAccountHome) => listing(`${agent}-model`))
    const probes = { codex: probeFor('codex'), claude: probeFor('claude'), pi: probeFor('pi') }
    // Claude has a catalog saved under another account; Codex has a chat; Pi was never used.
    store.recordSuccess('claude-other-account', 'claude', listing('opus'), 'discovery')
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async (agent) => HOME('HOME', `/homes/${agent}`),
      hasChatRecords: (agent) => agent === 'codex',
      probes
    })
    await service.prewarm()

    expect(probes.codex).toHaveBeenCalledTimes(1)
    expect(probes.claude).toHaveBeenCalledTimes(1)
    expect(probes.pi).not.toHaveBeenCalled()
    // Its first chat still lists it on demand.
    expect(await service.read({ agent: 'pi' })).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    expect(probes.pi).toHaveBeenCalledTimes(1)
  })

  it('on stop, starts no queued agent, stops the running listings and lists nothing more', async () => {
    const store = new AgentModelCatalogStore()
    const started: string[] = []
    const signals: AbortSignal[] = []
    const probeFor =
      (agent: string) => (_home: AgentSessionAccountHome, options?: { signal?: AbortSignal }) => {
        started.push(agent)
        const signal = options?.signal
        if (signal) {
          signals.push(signal)
        }
        return new Promise<AgentModelCatalogSuccess>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('stopped')))
        )
      }
    const agents = ['codex', 'claude', 'grok', 'opencode']
    const hasChatRecords = vi.fn(() => true)
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async (agent) => HOME('HOME', `/homes/${agent}`),
      hasChatRecords,
      probes: Object.fromEntries(agents.map((agent) => [agent, probeFor(agent)]))
    })
    const prewarmed = service.prewarm()
    await vi.waitFor(() => expect(started).toHaveLength(2))

    service.stop()
    await prewarmed
    expect(started).toEqual(['codex', 'claude'])
    expect(signals.every((signal) => signal.aborted)).toBe(true)

    // A read or another prewarm after stop spawns nothing.
    expect(await service.read({ agent: 'grok' })).toEqual({ origin: 'unknown' })
    hasChatRecords.mockClear()
    await service.prewarm()
    expect(started).toEqual(['codex', 'claude'])
    // Not even the chat records are read.
    expect(hasChatRecords).not.toHaveBeenCalled()
  })

  it('runs at most two listings at once', async () => {
    const store = new AgentModelCatalogStore()
    let running = 0
    let peak = 0
    const gates = new Map<string, () => void>()
    const probeFor = (agent: string) => async (): Promise<AgentModelCatalogSuccess> => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise<void>((resolve) => gates.set(agent, resolve))
      running -= 1
      return listing(`${agent}-model`)
    }
    const agents = ['codex', 'claude', 'grok', 'opencode', 'pi']
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => undefined,
      drivesRecord: () => true,
      hasChatRecords: () => true,
      resolveAccountHome: async (agent) => HOME('HOME', `/homes/${agent}`),
      probes: Object.fromEntries(agents.map((agent) => [agent, probeFor(agent)]))
    })
    const prewarmed = service.prewarm()
    for (const agent of agents) {
      await vi.waitFor(() => expect(gates.has(agent)).toBe(true))
      gates.get(agent)?.()
    }
    await prewarmed
    expect(peak).toBe(2)
  })
})

describe('one account, one catalog key', () => {
  function record(path: string): AgentSessionRecord {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the key reads only provider, accountHome and location.
    return {
      sessionId: 'session-1',
      provider: 'grok',
      accountHome: HOME('GROK_HOME', path),
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'ws-1',
        workspaceKind: 'git-worktree'
      }
    } as AgentSessionRecord
  }

  // The read and launch resolvers agreeing on the home is runtime-home-catalog-account-key.test.ts.
  it('a session’s saves through the host and through its adapter’s handle land under its record’s key', async () => {
    const store = new AgentModelCatalogStore()
    const managedHome = '/orca/grok-accounts/acct-1/home'
    const launched = record(managedHome)
    const service = createAgentModelCatalogService({
      store,
      getRecord: () => launched,
      drivesRecord: () => true,
      resolveAccountHome: async () => HOME('GROK_HOME', managedHome)
    })
    // What the chat saved, through the host and through the Grok adapter's own handle…
    service.recordLiveListing('session-1', { models: listing('gpt-live').models })
    const incoming = { models: [...listing('gpt-live').models, ...listing('gpt-new').models] }
    const retained = (launchOnlyModelId: string) =>
      service.retainedLiveModelIds('session-1', { ...incoming, launchOnlyModelId })
    expect(await retained('gpt-live')).toEqual(['gpt-live', 'gpt-new'])
    expect(await retained('gpt-new')).toEqual(['gpt-live'])
    const adapterAccess = agentModelCatalogSessionAccess(
      store,
      { agent: 'grok', accountHomeVariable: 'GROK_HOME' },
      managedHome
    )
    expect(adapterAccess?.fingerprint).toBe(agentModelCatalogFingerprintForRecord(launched))

    // …is what the next new chat reads for the same home: no cold start for this account.
    const read = await service.read({ agent: 'grok' })
    expect(read.origin !== 'unknown' && read.models.map((model) => model.id)).toEqual(['gpt-live'])
  })
})
