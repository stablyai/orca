import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  agentReadsProjectModelConfig,
  workspaceMayOverrideDefaultModel
} from '../native-chat/agent-model-catalog/agent-project-model-override'
import type { AgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store'
import { CALLER } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import { GROK_CONFIG_OPTIONS, PROVIDER_SESSION } from './acp-structured-adapter.test-support'

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { attachParams, openHostRig } from './acp-structured-host.test-support'

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
})
