import { describe, expect, it } from 'vitest'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'

describe('buildRelayHookEnvelope', () => {
  it('forwards complete provider inventory and turn identity', () => {
    const envelope = buildRelayHookEnvelope(
      {
        paneKey: 'tab:leaf',
        source: 'codex',
        connectionId: null,
        hookEventName: 'SessionIdle',
        providerTurnId: 'turn-1',
        providerTurnTerminal: true,
        providerTurnInventoryComplete: true,
        providerTurnInventory: {
          turnId: 'turn-1',
          joinedChildren: [],
          residentBackground: []
        },
        payload: { state: 'done', prompt: 'ship it', agentType: 'codex' }
      },
      'codex'
    )

    expect(envelope).toMatchObject({
      providerTurnId: 'turn-1',
      providerTurnTerminal: true,
      providerTurnInventoryComplete: true,
      providerTurnInventory: {
        turnId: 'turn-1',
        joinedChildren: [],
        residentBackground: []
      }
    })
  })
})
