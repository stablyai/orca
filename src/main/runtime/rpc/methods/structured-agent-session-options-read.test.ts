import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import '../unused-default-rpc-methods.test-fixture'
// The catalog read behind the picker: which directory a named worktree runs in on this host.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { createAgentModelCatalogService } from '../../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createCodexModelCatalogProbe } from '../../../codex/codex-model-catalog-probe'
import type { runCodexAppServerSession } from '../../../codex/codex-app-server-session'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  agentModelCatalogFingerprintForRecord,
  agentModelCatalogScopeFingerprint
} from '../../../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import {
  call,
  clearStructuredHostStub,
  hostStub,
  SESSION,
  STRUCTURED_CLIENT as OLD_STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

const STRUCTURED_CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
}

afterEach(() => {
  clearStructuredHostStub()
})

// These are RPC forwarding fixtures; receiving authority is exercised through the real host separately.
function catalogHost() {
  const host = hostStub()
  host.readModelCatalog = async (params) => {
    const catalog = host.deps.modelCatalog
    if (!params.savedOnly) {
      void catalog?.demand(params)
    }
    return catalog ? catalog.read(params) : { origin: 'unknown' }
  }
  return host
}

describe('agentSession.modelCatalog', () => {
  const read = vi.fn(async () => ({ origin: 'unknown' as const }))
  let record: AgentSessionRecord | null = null

  beforeEach(() => {
    read.mockClear()
    record = null
    setStructuredAgentSessionHost(
      Object.assign(catalogHost(), {
        deps: {
          modelCatalog: { read, demand: vi.fn(async () => {}) },
          store: {
            getRecord: () => record,
            getConversation: () => (record ? agentSessionConversationView(record) : null),
            requireWritableRecord: () => record
          },
          adapter: {}
        }
      })
    )
  })

  it('lists the local desktop catalog under its pinned account, folder and launch arguments', async () => {
    record = {
      ...agentSessionRecordFixture(),
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/account/work' },
      launchDirectory: '/repo/work'
    }
    const listed = vi.fn()
    const runSession: typeof runCodexAppServerSession = async (invocation, body) => {
      listed(invocation)
      expect(invocation).toMatchObject({
        command: '/installed/codex',
        cwd: '/repo/work',
        env: { CODEX_HOME: '/account/work' }
      })
      expect(invocation.args).toEqual(expect.arrayContaining(['-c', 'model_provider="work"']))
      return body({
        notify: () => {},
        request: async (method) =>
          method === 'model/list'
            ? {
                data: [{ model: 'work-model', isDefault: true, supportedReasoningEfforts: [] }],
                nextCursor: null
              }
            : { config: {} }
      })
    }
    const catalog = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getConversation: () => {
        const saved = record ?? undefined
        return saved ? agentSessionConversationView(saved) : undefined
      },
      getRecord: () => record ?? undefined,
      drivesRecord: () => true,
      recordWorkspacePath: async () => '/repo/work',
      resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/account/other' }),
      probes: {
        codex: createCodexModelCatalogProbe({
          resolveCommand: () => ({ command: '/installed/codex', prefixArgs: [] }),
          resolveEnvironment: async () => ({}),
          resolveLaunchArgs: () => ['-c', 'model_provider="work"'],
          runSession
        })
      }
    })
    setStructuredAgentSessionHost(
      Object.assign(catalogHost(), {
        deps: {
          modelCatalog: catalog,
          store: {
            getRecord: () => record,
            getConversation: () => (record ? agentSessionConversationView(record) : null),
            requireWritableRecord: () => record
          },
          adapter: {}
        }
      })
    )
    try {
      const reply = await call(
        'agentSession.modelCatalog',
        { agent: 'codex', sessionId: record.sessionId, waitForListing: true },
        STRUCTURED_CLIENT
      )
      expect(reply).toMatchObject({
        ok: true,
        result: { origin: 'probe', models: [{ id: 'work-model' }] }
      })
      expect(listed).toHaveBeenCalledTimes(1)
    } finally {
      catalog.stop()
    }
  })

  it("reads a floating chat's catalog in the folder it was created in", async () => {
    const fixture = agentSessionRecordFixture()
    record = {
      ...fixture,
      location: { ...fixture.location, workspaceId: FLOATING_TERMINAL_WORKTREE_ID },
      launchDirectory: '/home/me/floating-a'
    }
    // The floating setting has since moved to another folder.
    const resolveStructuredAgentSessionLocalWorkspacePath = vi.fn(async () => '/home/me/floating-b')
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION, worktree: `id:${FLOATING_TERMINAL_WORKTREE_ID}` },
      STRUCTURED_CLIENT,
      { resolveStructuredAgentSessionLocalWorkspacePath }
    )
    expect(resolveStructuredAgentSessionLocalWorkspacePath).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: SESSION,
      workspacePath: '/home/me/floating-a'
    })
  })

  it('reads the catalog for the directory the named worktree runs in on this host', async () => {
    const resolveStructuredAgentSessionLocalWorkspacePath = vi.fn(async () => '/repo/wt')
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION, worktree: 'id:wt-1' },
      STRUCTURED_CLIENT,
      { resolveStructuredAgentSessionLocalWorkspacePath }
    )
    expect(resolveStructuredAgentSessionLocalWorkspacePath).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: SESSION,
      workspace: expect.objectContaining({ selector: 'id:wt-1', resolve: expect.any(Function) })
    })
  })

  it('reads for an unplaced workspace when the worktree does not resolve', async () => {
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', worktree: 'id:missing' },
      STRUCTURED_CLIENT,
      {
        resolveStructuredAgentSessionLocalWorkspacePath: vi.fn(async () => {
          throw new Error('selector_not_found')
        })
      }
    )
    expect(read).toHaveBeenCalledWith({
      agent: 'codex',
      workspace: expect.objectContaining({ selector: 'id:missing', resolve: expect.any(Function) })
    })
  })

  it('reads as before when no worktree is named', async () => {
    await call('agentSession.modelCatalog', { agent: 'claude' }, STRUCTURED_CLIENT)
    expect(read).toHaveBeenCalledWith({ agent: 'claude' })
  })

  it('passes a wait for the listing through to the catalog', async () => {
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION, waitForListing: true },
      STRUCTURED_CLIENT
    )
    expect(read).toHaveBeenCalledWith({ agent: 'codex', sessionId: SESSION, waitForListing: true })
  })

  it('passes a saved-only read through to the catalog', async () => {
    await call('agentSession.modelCatalog', { agent: 'grok', savedOnly: true }, STRUCTURED_CLIENT)
    expect(read).toHaveBeenCalledWith({ agent: 'grok', savedOnly: true })
  })

  it('answers cold saved-only without resolution and reuses prepared memory for another equivalent chat', async () => {
    const pinned = { ...agentSessionRecordFixture(), provider: 'claude' }
    const key = agentModelCatalogScopeFingerprint(
      agentModelCatalogFingerprintForRecord(pinned),
      '/project',
      'saved-launch'
    )
    const seed = new AgentModelCatalogStore()
    const saved = seed.recordSuccess(
      key,
      'claude',
      {
        origin: 'probe',
        complete: true,
        models: [{ id: 'saved', label: 'Saved', isDefault: false, efforts: [] }]
      },
      'discovery'
    )!
    const store = new AgentModelCatalogStore()
    await store.attachPersistence({
      load: async () => [saved],
      save: () => {},
      flush: async () => {}
    })
    const folder = vi.fn(async () => '/project')
    const run = vi.fn(() => new Promise<never>(() => {}))
    const resolve = vi.fn(async () => ({ identity: 'saved-launch', run }))
    const catalog = createAgentModelCatalogService({
      store,
      getConversation: (id) => {
        const held = { ...pinned, sessionId: id }
        return held ? agentSessionConversationView(held) : undefined
      },
      getRecord: (id) => ({ ...pinned, sessionId: id }),
      drivesRecord: () => true,
      resolveAccountHome: vi.fn(() => new Promise<never>(() => {})),
      recordWorkspacePath: folder,
      probes: { claude: Object.assign(run, { resolve }) }
    })
    setStructuredAgentSessionHost(
      Object.assign(catalogHost(), {
        sessionAgent: () => 'claude',
        deps: {
          modelCatalog: catalog,
          store: {
            getConversation: (id: string) => {
              const held = { ...pinned, sessionId: id }
              return held ? agentSessionConversationView(held) : undefined
            },
            getRecord: (id: string) => ({ ...pinned, sessionId: id })
          },
          adapter: {}
        }
      })
    )
    try {
      const cold = await call(
        'agentSession.modelCatalog',
        { agent: 'claude', sessionId: 'session-cold-a', savedOnly: true },
        STRUCTURED_CLIENT
      )
      expect(cold.ok, JSON.stringify(cold)).toBe(true)
      expect(cold).toMatchObject({ result: { origin: 'unknown' } })
      expect(folder).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
      await catalog.prepareSaved({ agent: 'claude', sessionId: 'session-cold-a' })
      const calls = resolve.mock.calls.length
      expect(
        await call(
          'agentSession.modelCatalog',
          { agent: 'claude', sessionId: 'session-cold-b', savedOnly: true },
          STRUCTURED_CLIENT
        )
      ).toMatchObject({ ok: true, result: { models: [{ id: 'saved' }] } })
      expect(resolve).toHaveBeenCalledTimes(calls)
      expect(run).not.toHaveBeenCalled()
    } finally {
      catalog.stop()
    }
  })
})

describe('agentSession.modelCatalog before anything built the host', () => {
  const read = vi.fn(async () => ({
    origin: 'probe' as const,
    models: [{ id: 'gpt-host', label: 'GPT Host', isDefault: true, efforts: [] }],
    fetchedAt: 1
  }))
  const installHost = vi.fn(async () => {
    setStructuredAgentSessionHost(
      Object.assign(catalogHost(), {
        deps: {
          modelCatalog: { read, demand: vi.fn(async () => {}) },
          store: { getRecord: () => null, getConversation: () => null },
          adapter: {}
        }
      })
    )
  })

  beforeEach(() => {
    read.mockClear()
    installHost.mockClear()
    clearStructuredHostStub()
  })

  // New-chat pickers may be the first host caller; refusing before installation leaves only client-built-in models.
  it('builds the host for a structured chat and answers from its catalog', async () => {
    const reply = await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION },
      STRUCTURED_CLIENT,
      { ensureStructuredAgentSessionHost: installHost }
    )
    expect(installHost).toHaveBeenCalledTimes(1)
    expect(reply).toMatchObject({ ok: true, result: { origin: 'probe' } })
    expect(read).toHaveBeenCalledWith({ agent: 'codex', sessionId: SESSION })
  })

  // Session-less terminal-chat reads must use CLI listing without opening a structured journal.
  it('does not build the host for a read that names no session', async () => {
    const reply = await call('agentSession.modelCatalog', { agent: 'codex' }, STRUCTURED_CLIENT, {
      ensureStructuredAgentSessionHost: installHost
    })
    expect(installHost).not.toHaveBeenCalled()
    expect(reply).toMatchObject({ ok: false })
    expect(read).not.toHaveBeenCalled()
  })

  it('does not build the host for a client that cannot read structured sessions', async () => {
    const reply = await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION },
      { clientKind: 'runtime', clientCapabilities: [] },
      { ensureStructuredAgentSessionHost: installHost }
    )
    expect(installHost).not.toHaveBeenCalled()
    expect(reply).toMatchObject({ ok: false })
  })
})

describe('agentSession.modelCatalog for a chat on a model its CLI stopped listing', () => {
  const opus = { id: 'opus', label: 'Opus', isDefault: true, efforts: [] }
  const read = vi.fn(async (): Promise<AgentSessionModelCatalogResult> => ({
    origin: 'probe',
    fetchedAt: 1,
    models: [opus]
  }))
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(),
    provider: 'claude',
    options: { model: 'opus[1m]', effort: 'max' }
  }

  beforeEach(() => {
    setStructuredAgentSessionHost(
      Object.assign(catalogHost(), {
        deps: {
          modelCatalog: { read, demand: vi.fn(async () => {}) },
          store: {
            getRecord: () => record,
            getConversation: () => (record ? agentSessionConversationView(record) : null),
            requireWritableRecord: () => record
          },
          adapter: {}
        }
      })
    )
  })

  it("lists the chat's own model, so an older client that replaces an unlisted one keeps it", async () => {
    const own = {
      id: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'opus[1m]',
      isDefault: false,
      efforts: [],
      effortsKnown: false
    }
    const forChat = { agent: 'claude', sessionId: record.sessionId }
    expect(await call('agentSession.modelCatalog', forChat, OLD_STRUCTURED_CLIENT)).toMatchObject({
      ok: true,
      result: { models: [opus, own] }
    })
    // A new chat's read, which seeds the next new chat's list, and the account's name only the CLI's.
    const newChat = { ...forChat, worktree: 'id:wt-1' }
    const runtime = { resolveStructuredAgentSessionLocalWorkspacePath: async () => '/repo' }
    for (const reply of [
      await call('agentSession.modelCatalog', newChat, STRUCTURED_CLIENT, runtime),
      await call('agentSession.modelCatalog', { agent: 'claude' }, STRUCTURED_CLIENT)
    ]) {
      expect(reply).toMatchObject({ ok: true, result: { models: [opus] } })
    }
  })
})
