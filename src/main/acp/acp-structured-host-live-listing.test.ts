import { AcpStructuredOptions } from './acp-structured-options'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogEntry
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  agentReadsProjectModelConfig,
  workspaceMayOverrideDefaultModel
} from '../native-chat/agent-model-catalog/agent-project-model-override'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { GROK_CONFIG_OPTIONS, PROVIDER_SESSION } from './acp-structured-adapter.test-support'

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { attachParams, openAttachedHostRig, openHostRig } from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

describe('a live Grok listing', () => {
  it('saves a changed live menu for the next chat from its notification despite a failed probe', async () => {
    let records: AgentSessionRecordStore | undefined
    const catalog = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getRecord: (id) => records?.getRecord(id) ?? undefined,
      getConversation: (id) => records?.getConversation(id) ?? undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => ({ variable: 'GROK_HOME', path: '/grok' }),
      recordWorkspacePath: async () => '/workspace/project',
      agentReadsProjectModelConfig,
      workspaceMayOverrideDefaultModel,
      probes: {
        grok: async () => {
          throw new Error('session-free listing unavailable')
        }
      }
    })
    onTestFinished(() => catalog.stop())
    expect(await catalog.read({ agent: 'grok', waitForListing: true })).toMatchObject({
      origin: 'unknown'
    })
    const { host, rig, store, ready } = await openHostRig({ modelCatalog: catalog })
    records = store
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    const saved = () => catalog.read({ agent: 'grok', savedOnly: true })
    const initial = await saved()
    expect(initial).toMatchObject({
      origin: 'live-session',
      models: [
        { id: 'grok-4.7', isDefault: true },
        { id: 'grok-4.6', isDefault: false }
      ]
    })
    rig.child().agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: GROK_CONFIG_OPTIONS.map((option) =>
          option.id === 'model'
            ? {
                ...option,
                currentValue: 'grok-4.6',
                options: [...option.options, { value: 'grok-new', name: 'New model' }]
              }
            : option
        )
      }
    })
    await rig.settle()
    await vi.waitFor(async () => expect(await saved()).toHaveProperty('models.length', 3))
    const observed = await saved()
    expect(observed).toMatchObject({
      origin: 'live-session',
      models: [
        { id: 'grok-4.7', isDefault: true },
        { id: 'grok-4.6', isDefault: false },
        { id: 'grok-new', label: 'New model', isDefault: false }
      ]
    })
    await expect(host.readOptions(SESSION)).resolves.toMatchObject({
      current: { model: 'grok-4.6', effort: 'high' }
    })
    expect(await saved()).toEqual(observed)
    expect(store.getRecord(SESSION)?.options).toBeUndefined()
  })

  it('starts the chat even when saving its start listing throws', async () => {
    const modelCatalog: AgentModelCatalogService = {
      snapshot: vi.fn(() => ({ origin: 'unknown' as const })),
      demand: vi.fn(async () => {}),
      prepareSaved: vi.fn(async () => ({ origin: 'unknown' as const })),
      captureSource: () => () => true,
      retireContext: vi.fn(),
      peek: () => null,
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      recordLiveListing: vi.fn().mockImplementationOnce(() => {
        throw new Error('catalog unavailable')
      }),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted: vi.fn()
    }
    const { host, rig, store, fence } = await openAttachedHostRig({}, undefined, modelCatalog)
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    expect(store.getRecord(SESSION)?.lease.ownerProcess).toEqual(expect.any(Object))
    await expect(host.readOptions(SESSION)).resolves.toMatchObject({ current: expect.any(Object) })
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    expect(
      (await rig.adapter.readOptions({ sessionId: SESSION, fence: fence() })).current
    ).toMatchObject({
      model: 'grok-4.7',
      effort: 'high'
    })
    expect(store.getRecord(SESSION)?.options).toBeUndefined()
  })
})

it.each([
  [5, 20],
  [50, 20],
  [1, 200]
] as const)(
  'catalog-scale config notifications updates=%i models=%i',
  async (updates, modelRows) => {
    let records: AgentSessionRecordStore | undefined
    const store = new AgentModelCatalogStore()
    let saves = 0
    let savedBytes = 0
    let pending: (() => readonly AgentModelCatalogEntry[]) | undefined
    await store.attachPersistence({
      load: async () => [],
      save: (snapshot) => {
        saves++
        pending = snapshot
      },
      flush: async () => {
        const snapshot = pending
        pending = undefined
        if (snapshot) {
          savedBytes += Buffer.byteLength(JSON.stringify(snapshot()))
        }
      }
    })
    const catalog = createAgentModelCatalogService({
      store,
      getRecord: (id) => records?.getRecord(id) ?? undefined,
      getConversation: (id) => records?.getConversation(id) ?? undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => ({ variable: 'GROK_HOME', path: '/grok' }),
      recordWorkspacePath: async () => '/generated-project',
      agentReadsProjectModelConfig,
      workspaceMayOverrideDefaultModel: async () => false
    })
    const reads = vi.spyOn(AcpStructuredOptions.prototype, 'read')
    const publications = vi.spyOn(store, 'recordSuccess')
    try {
      const { host, rig, store: recordsStore, ready } = await openHostRig({ modelCatalog: catalog })
      records = recordsStore
      expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
      await ready()
      await rig.settle()
      await store.flushPersistence()
      saves = 0
      savedBytes = 0
      reads.mockClear()
      publications.mockClear()
      const configOptions = GROK_CONFIG_OPTIONS.map((option) =>
        option.id === 'model'
          ? {
              ...option,
              currentValue: 'grok-4.7',
              options: Array.from({ length: modelRows }, (_, index) => ({
                value: index === 0 ? 'grok-4.7' : `grok-model-${index}`,
                name: `Grok model ${index}`
              }))
            }
          : option
      )
      const notificationBytes = Buffer.byteLength(JSON.stringify(configOptions))
      const start = performance.now()
      for (let update = 0; update < updates; update++) {
        rig.child().agent.notify('session/update', {
          sessionId: PROVIDER_SESSION,
          update: { sessionUpdate: 'config_option_update', configOptions }
        })
      }
      await rig.settle()
      await vi.waitFor(() => expect(publications).toHaveBeenCalledTimes(updates))
      const projectionReads = reads.mock.calls.length
      const projectedModelRows = reads.mock.results.reduce(
        (count, result) => count + (result.type === 'return' ? result.value.models.length : 0),
        0
      )
      expect(projectionReads).toBe(updates * 2)
      expect(projectedModelRows).toBe(updates * modelRows * 2)
      expect(saves).toBe(1)
      await store.flushPersistence()
      const saved = await catalog.prepareSaved({
        agent: 'grok',
        sessionId: SESSION,
        inSessionWorkspace: true
      })
      if (saved.origin === 'unknown') {
        throw new Error('missing saved live catalog')
      }
      expect(saved.models).toHaveLength(modelRows)
      expect(saved.models[0]).toMatchObject({ id: 'grok-4.7', isDefault: true })
      process.stdout.write(
        `CATALOG_NOTIFICATIONS ${JSON.stringify({
          updates,
          modelRows,
          projectionReads,
          projectedModelRows,
          publicationCalls: publications.mock.calls.length,
          saves,
          savedBytes,
          notificationBytes,
          elapsedMs: performance.now() - start
        })}\n`
      )
    } finally {
      catalog.stop()
      reads.mockRestore()
      publications.mockRestore()
      await closeProviderTimelineRigs()
    }
  }
)
