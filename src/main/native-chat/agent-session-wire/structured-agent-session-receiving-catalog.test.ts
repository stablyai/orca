import { eraseRpcMethods, isStreamingMethod } from '../../runtime/rpc/core'
import { STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS } from '../../runtime/rpc/methods/structured-agent-session-options-read'
import * as receiving from './structured-agent-session-receiving-account'
import { observeReceivingSql } from './structured-agent-session-receiving-sql.test-support'
import {
  type AgentModelCatalogSuccess,
  AgentModelCatalogStore
} from '../agent-model-catalog/agent-model-catalog-store'
import type { AgentModelCatalogProbe } from '../agent-model-catalog/agent-model-catalog-discovery'
import { rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionAccountHomePath } from '../../../shared/agent-session-account-home'
import { REST_TEST_CALLER } from './structured-agent-session-rest-test-rig'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  catalogMutationDeadline as settled,
  disposeCatalogMutationHost
} from './structured-agent-session-catalog-mutation.test-support'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { structuredAgentModelCatalogAccountReads } from '../../runtime/structured-agent-model-catalog-wiring'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import {
  createReceivingCallerFixture,
  HOME_A,
  HOME_B,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'

function catalog(
  f: Awaited<ReturnType<typeof createReceivingCallerFixture>>,
  _countSavedScope = false
) {
  const store = new AgentModelCatalogStore()
  for (const [home, id] of [
    [HOME_A, 'claude-sonnet-5'],
    [HOME_B, 'claude-opus-5-5[1m]']
  ] as const) {
    store.recordSuccess(
      agentModelCatalogScopeFingerprint(
        agentModelCatalogFingerprint({ agent: 'claude', accountHome: home, wslDistro: null }),
        f.rig.root
      ),
      'claude',
      {
        models: [{ id, label: id, isDefault: true, efforts: [] }],
        origin: 'probe',
        complete: true
      },
      'discovery'
    )
  }
  const probe = vi.fn(async (): Promise<AgentModelCatalogSuccess> => {
    throw new Error('saved inventory must not probe')
  })
  const resolve = vi.fn(
    async (..._args: Parameters<NonNullable<AgentModelCatalogProbe['resolve']>>) => ({
      identity: undefined,
      run: probe
    })
  )
  const service = createAgentModelCatalogService({
    store,
    getConversation: (id) => f.rig.store.getConversation(id) ?? undefined,
    getRecord: (id) => f.rig.store.getRecord(id) ?? undefined,
    recordWorkspacePath: async () => f.rig.root,
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME_B,
    ...structuredAgentModelCatalogAccountReads(() => f.rig.host),
    probes: { claude: Object.assign(probe, { resolve }) },
    agentReadsProjectModelConfig: () => false
  })
  f.rig.host.deps.modelCatalog = service
  const demands = vi.spyOn(service, 'demand')
  const read = () => f.rig.host.readModelCatalog({ agent: 'claude', sessionId: PARENT })
  const completed = async (viaRpc = false) => {
    if (viaRpc) {
      const method = eraseRpcMethods(STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS).find(
        (entry) => entry.name === 'agentSession.modelCatalog'
      )
      if (!method?.params || isStreamingMethod(method)) {
        throw new Error('named catalog RPC is not installed')
      }
      await method.handler(method.params.parse({ agent: 'claude', sessionId: PARENT }), {
        runtime: f.runtime
      })
    } else {
      await read()
    }
    const claim = demands.mock.results.at(-1)?.value
    if (claim) {
      await settled(claim, 'named catalog demand completion')
    }
    const request = demands.mock.calls.at(-1)?.[0]
    return request ? service.snapshot(request) : { origin: 'unknown' as const }
  }
  return {
    service,
    store,
    probe,
    resolve,
    demands,
    read,
    ids: async (viaRpc = false) => {
      const result = await completed(viaRpc)
      expect(result.origin).not.toBe('unknown')
      if (result.origin === 'unknown') {
        throw new Error('catalog unexpectedly unknown')
      }
      return result.models.map((model) => model.id)
    }
  }
}

describe('catalog consumes the constructed host receiving account', () => {
  it('reads A before exact native disposition and B afterward, without the global registry', async () => {
    const f = await createReceivingCallerFixture()
    let service: ReturnType<typeof createAgentModelCatalogService> | undefined
    try {
      await f.found()
      const { started } = await f.coldNative()
      f.selectB()
      setStructuredAgentSessionHost(null)
      const c = catalog(f)
      service = c.service
      f.rig.adapter.acquire.mockClear()
      const all = vi.spyOn(f.rig.store, 'listRecords').mockImplementation(() => {
        throw new Error('global history scan')
      })
      expect(await c.ids()).toEqual(['claude-sonnet-5'])
      expect((await f.rig.host.readOptions(PARENT)).current.model).toBe('claude-sonnet-5')
      expect(f.rig.host.hasSession(PARENT)).toBe(true)
      const session = f.rig.host.collaboratorsForTests().sessions.get(PARENT)
      if (!session) {
        throw new Error('existing journal was not adopted')
      }
      const visits = vi.spyOn(session.journal, 'visitItemsWithLinkage')
      await c.read()
      expect(visits).not.toHaveBeenCalled()
      const db = f.runtime.getOrchestrationDb()
      db.failWorkerStart(started.dispatch.id, 'agent_readiness', 'never constructed a worker')
      expect(await c.ids()).toEqual(['claude-opus-5-5[1m]'])
      expect((await f.rig.host.readOptions(PARENT)).current.model).toBe('claude-opus-5-5[1m]')
      expect(c.probe).not.toHaveBeenCalled()
      expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
      all.mockRestore()
    } finally {
      service?.stop()
      await f.dispose()
    }
  })

  it('a proven absent journal still reads A from actual success and pre-notice work without founding one', async () => {
    const f = await createReceivingCallerFixture()
    let service: ReturnType<typeof createAgentModelCatalogService> | undefined
    try {
      await f.proveWithoutJournal()
      await f.coldNative()
      f.selectB()
      const c = catalog(f)
      service = c.service
      f.rig.adapter.acquire.mockClear()
      expect(await c.ids()).toEqual(['claude-sonnet-5'])
      expect(readJournalSessionEpoch(f.rig.host.deps.journalDatabase.db, PARENT)).toBeNull()
      expect(f.rig.host.hasSession(PARENT)).toBe(false)
      expect(c.probe).not.toHaveBeenCalled()
      expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
    } finally {
      service?.stop()
      await f.dispose()
    }
  })

  it('real prospective read failure answers unknown instead of using B cached facts', async () => {
    const f = await createReceivingCallerFixture()
    let service: ReturnType<typeof createAgentModelCatalogService> | undefined
    try {
      await f.found()
      await f.coldNative()
      f.selectB()
      const c = catalog(f)
      service = c.service
      const db = f.runtime.getOrchestrationDb()
      const prepare = db.db.prepare.bind(db.db)
      vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
        if (sql.includes('SELECT id FROM runs WHERE coordinator_orca_session_id')) {
          throw new Error('native read unavailable')
        }
        return prepare(sql)
      })
      expect(await c.read()).toEqual({ origin: 'unknown' })
      expect(c.probe).not.toHaveBeenCalled()
      expect(f.rig.host.childAccountHome(PARENT)).toBeUndefined()
    } finally {
      service?.stop()
      await f.dispose()
    }
  })

  // Real journal/native DB setup, two 2s mutations and bounded host cleanup share this budget.
  it('owned permission settlement reads actual A until exact native disposition, then eligible B', async () => {
    const f = await createReceivingCallerFixture()
    let service: ReturnType<typeof createAgentModelCatalogService> | undefined
    try {
      await f.found()
      const { started } = await f.coldNative()
      f.selectB()
      setStructuredAgentSessionHost(null)
      const c = catalog(f)
      service = c.service
      f.rig.adapter.acquire.mockClear()
      const all = vi.spyOn(f.rig.store, 'listRecords').mockImplementation(() => {
        throw new Error('global history scan')
      })
      const pick = async () => {
        const key = 'permissionMode'
        const value = 'own'
        expect(
          await settled(
            f.rig.host.setOption(REST_TEST_CALLER, {
              key,
              value,
              envelope: {
                sessionId: PARENT,
                clientOperationId: hostTestOperationId(),
                expectedRuntimeFence: f.rig.store.requireWritableRecord(PARENT).lease.runtimeFence,
                payloadFingerprint: computeAgentSessionPayloadFingerprint({
                  method: 'agentSession.setOption',
                  sessionId: PARENT,
                  fields: { key, value }
                })
              }
            }),
            'receiving-account permission mutation'
          )
        ).toMatchObject({
          ok: true,
          value: { key, value, options: { permissionMode: 'own' } }
        })
        expect(f.rig.store.requireWritableRecord(PARENT).permissionMode).toBe('own')
        return undefined
      }
      await pick()
      expect(await c.ids()).toEqual(['claude-sonnet-5'])
      f.runtime
        .getOrchestrationDb()
        .failWorkerStart(started.dispatch.id, 'agent_readiness', 'never constructed a worker')
      await pick()
      expect(await c.ids()).toEqual(['claude-opus-5-5[1m]'])
      expect(c.probe).not.toHaveBeenCalled()
      expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
      expect(f.rig.adapter.dispatch).not.toHaveBeenCalled()
      expect(f.rig.adapter.readOptions).not.toHaveBeenCalled()
      expect(all).not.toHaveBeenCalled()
    } finally {
      service?.stop()
      await f.dispose(
        () => disposeCatalogMutationHost(f.rig),
        () => rm(f.rig.root, { recursive: true, force: true })
      )
    }
  }, 10_000)
})

// Real cold adoption, N serialized mutations and bounded cleanup share the existing catalog budget.
it.each([10, 100])(
  'counts inventory-independent picks and explicit receiving catalog work over %i operations',
  async (n) => {
    const f = await createReceivingCallerFixture()
    let service: ReturnType<typeof createAgentModelCatalogService> | undefined
    try {
      await f.found()
      const { started } = await f.coldNative()
      f.selectB()
      const c = catalog(f, true)
      service = c.service
      f.rig.adapter.acquire.mockClear()
      const entries = vi.spyOn(receiving, 'structuredAgentSessionReceivingAccount')
      const external = vi.spyOn(f.rig.host, 'prospectiveAccountHome')
      const all = vi.spyOn(f.rig.store, 'listRecords').mockImplementation(() => {
        throw new Error('global history scan')
      })
      const pick = async () => {
        const key = 'permissionMode'
        const value = 'own'
        expect(
          await settled(
            f.rig.host.setOption(REST_TEST_CALLER, {
              key,
              value,
              envelope: {
                sessionId: PARENT,
                clientOperationId: hostTestOperationId(),
                expectedRuntimeFence: f.rig.store.requireWritableRecord(PARENT).lease.runtimeFence,
                payloadFingerprint: computeAgentSessionPayloadFingerprint({
                  method: 'agentSession.setOption',
                  sessionId: PARENT,
                  fields: { key, value }
                })
              }
            }),
            'owned catalog counted mutation'
          )
        ).toMatchObject({
          ok: true,
          value: { key, value, options: { permissionMode: 'own' } }
        })
        expect(f.rig.store.requireWritableRecord(PARENT).permissionMode).toBe('own')
        return undefined
      }
      const measure = async (count: number, work: () => Promise<void>) => {
        entries.mockClear()
        external.mockClear()
        c.resolve.mockClear()
        c.demands.mockClear()
        const observed = observeReceivingSql(f.runtime.getOrchestrationDb())
        try {
          await work()
          expect(entries).toHaveBeenCalledTimes(count)
          expect(c.resolve).toHaveBeenCalledTimes(count)
          expect(
            c.resolve.mock.calls.every(
              ([, cwd, lookup]) => cwd === f.rig.root && lookup === 'snapshot'
            )
          ).toBe(true)
          expect(observed.measurements.prepares).toBeLessThanOrEqual(20 * count)
          expect(observed.measurements.allRows).toBeLessThanOrEqual(8 * count)
          expect(observed.measurements.plans.length).toBeGreaterThan(0)
          expect(
            observed.measurements.plans.filter((detail) =>
              /\bSCAN (?:run|child|task|parent|messages|dispatch_contexts|agent_session_records)\b/.test(
                detail
              )
            )
          ).toEqual([])
          expect(c.probe).not.toHaveBeenCalled()
          expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
          expect(f.rig.adapter.dispatch).not.toHaveBeenCalled()
          expect(f.rig.adapter.readOptions).not.toHaveBeenCalled()
          expect(all).not.toHaveBeenCalled()
          process.stdout.write(
            `owned-catalog operations=${count} receiving=${entries.mock.calls.length} snapshotResolutions=${c.resolve.mock.calls.length} sql=${observed.measurements.prepares} rows=${observed.measurements.allRows}\n`
          )
        } finally {
          observed.stop()
        }
      }
      entries.mockClear()
      c.resolve.mockClear()
      c.demands.mockClear()
      const preparation = vi.spyOn(c.service, 'prepareSaved')
      const reads = vi.spyOn(c.service, 'read')
      const pickedSql = observeReceivingSql(f.runtime.getOrchestrationDb())
      try {
        for (let i = 0; i < n; i += 1) {
          await pick()
        }
        expect(entries).not.toHaveBeenCalled()
        expect(c.resolve).not.toHaveBeenCalled()
        expect(c.demands).not.toHaveBeenCalled()
        expect(preparation).not.toHaveBeenCalled()
        expect(reads).not.toHaveBeenCalled()
        expect(pickedSql.measurements.prepares).toBe(0)
        expect(pickedSql.measurements.allRows).toBe(0)
      } finally {
        pickedSql.stop()
      }
      await measure(n, async () => {
        for (let i = 0; i < n; i += 1) {
          const options = await settled(
            f.rig.host.readOptions(PARENT, { readsWithoutModel: false }),
            'explicit legacy options'
          )
          expect(options.current.model).toBe('claude-sonnet-5')
        }
      })
      expect(preparation).toHaveBeenCalledTimes(n)
      expect(reads.mock.calls.length).toBeGreaterThan(0)
      expect(external).not.toHaveBeenCalled()
      expect(
        c.resolve.mock.calls.every(([home]) => agentSessionAccountHomePath(home) === HOME_A.path)
      ).toBe(true)
      entries.mockClear()
      c.resolve.mockClear()
      c.demands.mockClear()
      expect(await c.ids(true)).toEqual(['claude-sonnet-5'])
      expect(entries).toHaveBeenCalledTimes(1)
      expect(c.resolve).toHaveBeenCalledTimes(1)
      expect(c.demands).toHaveBeenCalledTimes(1)
      const before = await f.rig.host.readOptions(PARENT)
      f.runtime
        .getOrchestrationDb()
        .failWorkerStart(started.dispatch.id, 'agent_readiness', 'never constructed a worker')
      await measure(1, async () => {
        const [picked, listed] = await settled(
          Promise.all([pick(), f.rig.host.readOptions(PARENT, { readsWithoutModel: false })]),
          'parallel owned/external catalog consumers'
        )
        expect(picked).toBeUndefined()
        expect(listed.current.model).toBe('claude-opus-5-5[1m]')
      })
      expect(external).not.toHaveBeenCalled()
      expect(before.current.model).toBe('claude-sonnet-5')
      expect(
        c.resolve.mock.calls.every(([home]) => agentSessionAccountHomePath(home) === HOME_B.path)
      ).toBe(true)
    } finally {
      service?.stop()
      await f.dispose(
        () => disposeCatalogMutationHost(f.rig),
        () => rm(f.rig.root, { recursive: true, force: true })
      )
    }
  },
  10_000
)

// These operations run the real host owner and catalog claim; only external provider IO is scripted.
it('keeps newer public intent while discovery waits and reports a failed listing without holding Stop', async () => {
  const f = await createReceivingCallerFixture()
  let service: ReturnType<typeof createAgentModelCatalogService> | undefined
  const listing = Promise.withResolvers<AgentModelCatalogSuccess>()
  try {
    await f.found()
    await f.rig.host.close(PARENT, 'evict')
    f.rig.adapter.acquire.mockClear()
    const c = catalog(f, true)
    service = c.service
    c.store.expireAgent('claude')
    c.probe.mockImplementationOnce(() => listing.promise)
    const reading = f.rig.host.readOptions(PARENT, { readsWithoutModel: false })
    await vi.waitFor(() => expect(c.probe).toHaveBeenCalledOnce())
    const pick = (key: string, value: string) =>
      f.rig.host.setOption(REST_TEST_CALLER, {
        key,
        value,
        envelope: {
          sessionId: PARENT,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: f.rig.store.requireWritableRecord(PARENT).lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.setOption',
            sessionId: PARENT,
            fields: { key, value }
          })
        }
      })
    expect(
      await settled(pick('model', 'claude-opus-5-5[1m]'), 'newer public model pick')
    ).toMatchObject({ ok: true })
    expect(await settled(pick('effort', 'low'), 'newer public effort pick')).toMatchObject({
      ok: true
    })
    listing.resolve({
      models: [{ id: 'old-listing', label: 'Old', isDefault: true, efforts: [] }],
      origin: 'probe',
      complete: true
    })
    expect(await settled(reading, 'pending legacy reader')).toMatchObject({
      current: { model: 'claude-opus-5-5[1m]', effort: 'low' }
    })
    expect(f.rig.store.requireWritableRecord(PARENT).options).toMatchObject({
      model: 'claude-opus-5-5[1m]',
      effort: 'low'
    })
    f.selectB()
    c.store.expireAgent('claude')
    c.probe.mockRejectedValueOnce(new Error('model/list unavailable'))
    const failed = await c.read()
    expect(failed.origin).toBe('unknown')
    const claim = c.demands.mock.results.at(-1)?.value
    if (!claim) {
      throw new Error('real named demand was not installed')
    }
    await settled(claim, 'failed discovery settlement')
    const request = c.demands.mock.calls.at(-1)?.[0]
    if (!request) {
      throw new Error('real named demand has no request')
    }
    expect(c.service.snapshot(request).origin).toBe('unknown')
    expect(
      c.store.failureDetail(
        agentModelCatalogScopeFingerprint(
          agentModelCatalogFingerprint({ agent: 'claude', accountHome: HOME_B, wslDistro: null }),
          f.rig.root
        )
      )
    ).toContain('model/list unavailable')
    expect(
      await settled(
        f.rig.host.cancel(REST_TEST_CALLER, {
          envelope: {
            sessionId: PARENT,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: f.rig.store.requireWritableRecord(PARENT).lease.runtimeFence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.cancel',
              sessionId: PARENT,
              fields: {}
            })
          }
        }),
        'public Stop after listing failure'
      )
    ).toMatchObject({ ok: true })
    expect(
      await settled(pick('permissionMode', 'own'), 'ordinary action after failed listing and Stop')
    ).toMatchObject({ ok: true })
    expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
    expect(f.rig.adapter.dispatch).not.toHaveBeenCalled()
  } finally {
    listing.resolve({ models: [], origin: 'probe', complete: true })
    service?.stop()
    await f.dispose()
  }
})

it.each(['deadline', 'retirement', 'stop', 'workspace'] as const)(
  'captures the original %s fence before awaiting the receiving scope',
  async (end) => {
    const f = await createReceivingCallerFixture()
    let service: ReturnType<typeof createAgentModelCatalogService> | undefined
    const home = Promise.withResolvers<typeof HOME_B>()
    try {
      await f.found()
      await f.rig.host.close(PARENT, 'evict')
      f.rig.adapter.acquire.mockClear()
      const c = catalog(f, true)
      service = c.service
      const selected = vi.spyOn(f.rig.host.deps, 'launchAccountHome').mockReturnValue(home.promise)
      let workspaceIdentity = 'original'
      const now = 1_800_000_000_000
      vi.useFakeTimers({ now })
      const pending = f.rig.host.readModelCatalog({
        agent: 'claude',
        sessionId: PARENT,
        deadline: now + 500,
        ...(end === 'workspace'
          ? {
              workspace: {
                selector: 'fixture',
                identity: () => workspaceIdentity,
                resolve: async () => f.rig.root
              }
            }
          : {})
      })
      await vi.waitFor(() => expect(selected).toHaveBeenCalledOnce())
      if (end === 'workspace') {
        workspaceIdentity = 'replacement'
      }
      if (end === 'retirement') {
        c.store.expireAgent('claude')
      }
      if (end === 'stop') {
        c.service.stop()
      }
      if (end === 'deadline') {
        await vi.advanceTimersByTimeAsync(500)
        expect(await settled(pending, 'original scope deadline')).toEqual({ origin: 'unknown' })
      }
      home.resolve(HOME_B)
      expect(await settled(pending, 'retired scope completion')).toEqual({ origin: 'unknown' })
      expect(c.demands).not.toHaveBeenCalled()
      expect(c.resolve).not.toHaveBeenCalled()
      expect(c.probe).not.toHaveBeenCalled()
      expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
    } finally {
      home.resolve(HOME_B)
      service?.stop()
      vi.useRealTimers()
      await f.dispose()
    }
  }
)
