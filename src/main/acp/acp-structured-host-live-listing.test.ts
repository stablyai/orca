// A running Grok chat's own model list, read through the real host, reaches the account's saved
// catalog: the next chat opens warm even when a session-free listing failed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { openAttachedHostRig } from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

describe('a live Grok listing', () => {
  it('is saved through the host catalog when the chat reads its options', async () => {
    const modelCatalog: AgentModelCatalogService = {
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      recordLiveListing: vi.fn(),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted: vi.fn()
    }
    const { host } = await openAttachedHostRig({}, undefined, modelCatalog)

    // Its start was saved once as the chat attached; this read is saved too.
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    await host.readOptions(SESSION)

    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(2)
    const [sessionId, listing] = vi.mocked(modelCatalog.recordLiveListing).mock.calls[1]!
    expect(sessionId).toBe(SESSION)
    expect(listing.models.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.6'])
    // The session's picks are no one's default, and only its start says what its config resolved.
    expect(listing.models.every((model) => !model.isDefault)).toBe(true)
    expect(listing).not.toHaveProperty('configuredDefault')
  })

  it('starts the chat even when saving its start listing throws', async () => {
    const modelCatalog: AgentModelCatalogService = {
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      recordLiveListing: vi.fn(() => {
        throw new Error('catalog unavailable')
      }),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted: vi.fn()
    }
    // The rig's attach must succeed: bookkeeping never fails a proven start.
    const { store } = await openAttachedHostRig({}, undefined, modelCatalog)
    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    expect(store.getRecord(SESSION)?.lease.ownerProcess).not.toBeNull()
  })
})
