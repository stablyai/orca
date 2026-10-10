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

    await host.readOptions(SESSION)

    expect(modelCatalog.recordLiveListing).toHaveBeenCalledTimes(1)
    const [sessionId, listing] = vi.mocked(modelCatalog.recordLiveListing).mock.calls[0]!
    expect(sessionId).toBe(SESSION)
    expect(listing.models.map((model) => model.id)).toEqual(['grok-4.7', 'grok-4.6'])
    // The session's picks are no one's default.
    expect(listing.models.every((model) => !model.isDefault)).toBe(true)
  })
})
