import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_BOT_LINEAGE_RUNTIME_CAPABILITY } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrchestrationDb } from '../db/orchestration-db'
import {
  federatedAttachmentBotLineage,
  federatedWorkerBotLineage,
  forwardedFederatedBotLineage
} from './federated-worker-chat-lineage'

describe('forwardedFederatedBotLineage', () => {
  it('sends a bot-home lineage stamp only to a peer that advertises support', () => {
    expect(
      forwardedFederatedBotLineage(true, [
        ORCHESTRATION_BOT_LINEAGE_RUNTIME_CAPABILITY
      ])
    ).toEqual({ botLineage: true })
    expect(forwardedFederatedBotLineage(true, [])).toEqual({})
    expect(
      forwardedFederatedBotLineage(false, [
        ORCHESTRATION_BOT_LINEAGE_RUNTIME_CAPABILITY
      ])
    ).toEqual({})
  })

  it('recognizes direct bot-home starts, retries, and bot helpers before forwarding', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const runtime = { bots: { list: () => [{ folderWorkspaceId: 'bot-home' }] } }
      const caller = { sessionId: 'session', workspaceId: 'folder:bot-home' }
      expect(
        federatedWorkerBotLineage(
          runtime as Parameters<typeof federatedWorkerBotLineage>[0],
          db,
          {},
          caller as Parameters<typeof federatedWorkerBotLineage>[3]
        )
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('accepts the attached lineage only from an authenticated paired transport', () => {
    const pairedRuntime = {
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device',
      authenticatedCallerFingerprint: 'fingerprint'
    }
    expect(federatedAttachmentBotLineage(true, pairedRuntime)).toBe(true)
    expect(
      federatedAttachmentBotLineage(true, {
        ...pairedRuntime,
        pairedDeviceId: undefined
      })
    ).toBe(false)
    expect(
      federatedAttachmentBotLineage(true, {
        ...pairedRuntime,
        authenticatedCallerFingerprint: undefined
      })
    ).toBe(false)
    expect(
      federatedAttachmentBotLineage(true, {
        ...pairedRuntime,
        clientKind: undefined
      })
    ).toBe(false)
    expect(federatedAttachmentBotLineage(undefined, pairedRuntime)).toBe(false)
  })
})
