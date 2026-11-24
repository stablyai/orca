import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { forwardedFederatedChatLineage } from './federated-worker-chat-lineage'

describe('forwardedFederatedChatLineage', () => {
  it('sends a bot-home lineage stamp only to a peer that advertises support', () => {
    expect(
      forwardedFederatedChatLineage(true, [ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY])
    ).toEqual({ chatLineage: true })
    expect(forwardedFederatedChatLineage(true, [])).toEqual({})
    expect(
      forwardedFederatedChatLineage(false, [ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY])
    ).toEqual({})
  })
})
