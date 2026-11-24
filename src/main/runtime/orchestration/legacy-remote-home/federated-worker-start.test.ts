import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_FEDERATION_CHAT_LINEAGE_RUNTIME_CAPABILITY } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrchestrationDb } from '../db/orchestration-db'
import {
  federatedAttachmentChatLineage,
  federatedWorkerChatLineage,
  forwardedFederatedChatLineage
} from './federated-worker-chat-lineage'

describe('forwardedFederatedChatLineage', () => {
  it('sends a bot-home lineage stamp only to a peer that advertises support', () => {
    expect(
      forwardedFederatedChatLineage(true, [
        ORCHESTRATION_FEDERATION_CHAT_LINEAGE_RUNTIME_CAPABILITY
      ])
    ).toEqual({ chatLineage: true })
    expect(forwardedFederatedChatLineage(true, [])).toEqual({})
    expect(
      forwardedFederatedChatLineage(false, [
        ORCHESTRATION_FEDERATION_CHAT_LINEAGE_RUNTIME_CAPABILITY
      ])
    ).toEqual({})
  })

  it('recognizes direct bot-home starts, retries, and bot helpers before forwarding', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const runtime = { bots: { list: () => [{ folderWorkspaceId: 'bot-home' }] } }
      const caller = { sessionId: 'session', workspaceId: 'folder:bot-home' }
      expect(
        federatedWorkerChatLineage(
          runtime as Parameters<typeof federatedWorkerChatLineage>[0],
          db,
          {},
          caller as Parameters<typeof federatedWorkerChatLineage>[3]
        )
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('accepts the attached lineage only with an authenticated mutation', () => {
    expect(federatedAttachmentChatLineage(true, true)).toBe(true)
    expect(federatedAttachmentChatLineage(true, false)).toBe(false)
    expect(federatedAttachmentChatLineage(undefined, true)).toBe(false)
  })
})
