import { recordProviderChildEnd } from '../native-chat/agent-session-wire/structured-agent-session-provider-child'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { attachParams, openHostRig, openAttachedHostRig } from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

describe('a live Grok listing', () => {
  it('publishes startup and read snapshots under the indexed owning generation', async () => {
    let readScope: () => string | null = () => null
    const scopes: (string | null)[] = []
    const modelCatalog: AgentModelCatalogService = {
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      peek: () => null,
      processCatalog: () => null,
      retainedLiveModelIds: vi.fn(() => []),
      recordLiveListing: vi.fn(() => {
        scopes.push(readScope())
      }),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted: vi.fn()
    }
    const { host } = await openHostRig({ modelCatalog })
    readScope = () => host.modelCatalogProcessScope(SESSION)
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    expect(scopes[0]).toContain('generation-')
    expect(scopes[0]).not.toContain('unverifiable')

    // Its start was saved once as the chat attached; this read is saved too.
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    await host.readOptions(SESSION)

    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(2)
    expect(scopes[1]).toBe(scopes[0])
    const [sessionId, listing] = vi.mocked(modelCatalog.recordLiveListing).mock.calls[1]!
    expect(sessionId).toBe(SESSION)
    expect(listing.models.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.6'])
    // Current rows do not become defaults; the generation keeps its startup configuration.
    expect(listing.models.every((model) => !model.isDefault)).toBe(true)
    expect(listing.configuredDefault).toEqual({ modelId: 'grok-4.7', effort: 'high' })
    const conversation = host.collaboratorsForTests().sessions.get(SESSION)!
    const child = conversation.child!
    const ended = { ...child, cause: 'exit' as const, reason: null, duringStartup: false }
    recordProviderChildEnd(conversation, { ...ended, rootGone: false })
    expect(readScope()).toBe(scopes[0])
    recordProviderChildEnd(conversation, { ...ended, rootGone: true })
    expect(readScope()).toBeNull()
    await host.readOptions(SESSION)
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(2)
  })

  it('starts the chat even when saving its start listing throws', async () => {
    const modelCatalog: AgentModelCatalogService = {
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      peek: () => null,
      processCatalog: () => null,
      retainedLiveModelIds: vi.fn(() => []),
      recordLiveListing: vi.fn().mockImplementationOnce(() => {
        throw new Error('catalog unavailable')
      }),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted: vi.fn()
    }
    // The rig's attach must succeed: bookkeeping never fails a proven start.
    const { host, store } = await openAttachedHostRig({}, undefined, modelCatalog)
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    expect(store.getRecord(SESSION)?.lease.ownerProcess).not.toBeNull()
    await expect(host.readOptions(SESSION)).resolves.toHaveProperty('models')
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(2)
  })
})
