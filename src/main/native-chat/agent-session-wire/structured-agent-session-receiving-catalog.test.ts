import {
  type AgentModelCatalogSuccess,
  AgentModelCatalogStore
} from '../agent-model-catalog/agent-model-catalog-store'
import type { AgentModelCatalogProbe } from '../agent-model-catalog/agent-model-catalog-discovery'
import { expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { REST_TEST_CALLER } from './structured-agent-session-rest-test-rig'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import { catalogMutationDeadline as settled } from './structured-agent-session-catalog-mutation.test-support'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { structuredAgentModelCatalogAccountReads } from '../../runtime/structured-agent-model-catalog-wiring'
import {
  createReceivingCallerFixture,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'

function catalog(f: Awaited<ReturnType<typeof createReceivingCallerFixture>>) {
  const store = new AgentModelCatalogStore()
  for (const [home, id] of [
    [f.homeA, 'claude-sonnet-5'],
    [f.homeB, 'claude-opus-5-5[1m]']
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
    resolveAccountHome: async () => f.homeB,
    ...structuredAgentModelCatalogAccountReads(() => f.rig.host),
    probes: { claude: Object.assign(probe, { resolve }) },
    agentReadsProjectModelConfig: () => false
  })
  f.rig.host.deps.modelCatalog = service
  const demands = vi.spyOn(service, 'demand')
  const read = () => f.rig.host.readModelCatalog({ agent: 'claude', sessionId: PARENT })
  return {
    service,
    store,
    probe,
    resolve,
    demands,
    read
  }
}

// These operations run the real host owner and catalog claim; only external provider IO is scripted.
it('keeps newer public intent while discovery waits and reports a failed listing without holding Stop', async () => {
  const f = await createReceivingCallerFixture()
  let service: ReturnType<typeof createAgentModelCatalogService> | undefined
  const listing = Promise.withResolvers<AgentModelCatalogSuccess>()
  try {
    await f.found()
    await f.rig.host.close(PARENT, 'evict')
    f.rig.adapter.acquire.mockClear()
    const c = catalog(f)
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
          agentModelCatalogFingerprint({ agent: 'claude', accountHome: f.homeB, wslDistro: null }),
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
    const home = Promise.withResolvers<typeof f.homeB>()
    try {
      await f.found()
      await f.rig.host.close(PARENT, 'evict')
      f.rig.adapter.acquire.mockClear()
      const c = catalog(f)
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
      home.resolve(f.homeB)
      expect(await settled(pending, 'retired scope completion')).toEqual({ origin: 'unknown' })
      expect(c.demands).not.toHaveBeenCalled()
      expect(c.resolve).not.toHaveBeenCalled()
      expect(c.probe).not.toHaveBeenCalled()
      expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
    } finally {
      home.resolve(f.homeB)
      service?.stop()
      vi.useRealTimers()
      await f.dispose()
    }
  }
)
