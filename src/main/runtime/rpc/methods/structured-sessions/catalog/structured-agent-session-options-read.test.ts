import { resolveHiddenProbeCwd } from '../../../../../lib/hidden-probe-cwd'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'

// The catalog read behind the picker: which directory a named worktree runs in on this host.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../../../ipc/desktop-renderer-runtime-capabilities'
import { createAgentModelCatalogService } from '../../../../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../../../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentModelCatalogSuccess } from '../../../../../native-chat/agent-model-catalog/agent-model-catalog-entry'
import '../../../../../codex/structured/catalog/codex-model-catalog-probe'

import type { AgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-record'

import { agentSessionRecordFixture } from '../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import '../../../../../native-chat/agent-model-catalog/agent-model-catalog-listing-waiters'
import {
  agentModelCatalogFingerprintForRecord,
  agentModelCatalogScopeFingerprint
} from '../../../../../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import {
  call,
  clearStructuredHostStub,
  hostStub
} from '../protocol/structured-agent-session-rpc.test-fixture'

import '../protocol/structured-agent-session-rpc-client.test-fixture'

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
  const demand = vi.fn(async () => {})
  let readCurrent = true
  const captureRead = vi.fn(() => ({ current: () => readCurrent }))
  let record: AgentSessionRecord | null = null

  beforeEach(() => {
    read.mockClear()
    demand.mockClear()
    captureRead.mockClear()
    readCurrent = true
    record = null
    setStructuredAgentSessionHost(
      Object.assign(catalogHost(), {
        deps: {
          modelCatalog: { read, demand, captureRead },
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

  it.each([false, true])(
    'negotiates early progress through the existing client capability (enabled=%s)',
    async (enabled) => {
      record = { ...agentSessionRecordFixture(), provider: 'codex' }
      const result = await call(
        'agentSession.modelCatalog',
        { agent: 'codex', sessionId: record.sessionId, waitForListing: true },
        {
          ...STRUCTURED_CLIENT,
          clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES.filter(
            (capability) => enabled || capability !== 'agent-session.model-catalog.progress.v1'
          )
        }
      )
      expect(result.ok, JSON.stringify(result)).toBe(true)
      expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ progress: enabled }))
    }
  )

  it("keeps a moved floating workspace's list apart from the old folder's late answer", async () => {
    const late = Promise.withResolvers<AgentModelCatalogSuccess>()
    const listed = (id: string): AgentModelCatalogSuccess => ({
      origin: 'probe',
      complete: true,
      models: [{ id, label: id, isDefault: false, efforts: [] }]
    })
    const probe = vi.fn(async (_home: unknown, options?: { workspacePath?: string }) =>
      options?.workspacePath === '/a' ? late.promise : listed('b-model')
    )
    const catalog = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getConversation: () => undefined,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => ({ variable: 'HOME', path: '/account' }),
      listsInChatFolder: new Set(['opencode']),
      probes: { opencode: probe }
    })
    let folder = '/a'
    const runtime = {
      structuredAgentModelCatalog: async () => catalog,
      resolveStructuredAgentCatalogWorkspacePath: async () => folder
    }
    const open = (waitForListing?: true) =>
      call(
        'agentSession.modelCatalog',
        { agent: 'opencode', worktree: `id:${FLOATING_TERMINAL_WORKTREE_ID}`, waitForListing },
        STRUCTURED_CLIENT,
        runtime
      )
    try {
      await open()
      await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
      folder = '/b'
      expect(await open(true)).toMatchObject({ ok: true, result: { models: [{ id: 'b-model' }] } })
      late.resolve(listed('a-model'))
      await vi.waitFor(async () =>
        expect(await catalog.read({ agent: 'opencode', workspacePath: '/a' })).toMatchObject({
          models: [{ id: 'a-model' }]
        })
      )
      expect(await open(true)).toMatchObject({ ok: true, result: { models: [{ id: 'b-model' }] } })
    } finally {
      late.resolve(listed('a-model'))
      catalog.stop()
    }
  })

  it('answers cold saved-only without resolution and reuses prepared memory for another equivalent chat', async () => {
    const pinned = { ...agentSessionRecordFixture(), provider: 'claude' }
    const key = agentModelCatalogScopeFingerprint(
      agentModelCatalogFingerprintForRecord(pinned),
      resolveHiddenProbeCwd(),
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
