import { beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionPromptCancelRoute } from './structured-agent-session-adapter-stop'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState,
  seedApproval
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

let host: StructuredAgentSessionHost
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>

beforeEach(() => {
  ;({ host, cancelTurn } = hostTestState())
})

it.each<AgentSessionPromptCancelRoute['kind']>(['stop', 'dismiss'])(
  "a card's Cancel still settles the card when the turn its Stop named already ended (%s route)",
  async (kind) => {
    await attach()
    const prompt = await seedApproval()
    const dismissPrompt = vi.fn<NonNullable<StructuredAgentSessionAdapter['dismissPrompt']>>(
      async ({ commit }) => commit()
    )
    Object.assign(host.deps.adapter, { routePromptCancel: () => ({ kind }), dismissPrompt })
    // Pressed while turn-2 ran; it ended before the request was processed.
    const fields = {
      turnId: 'turn-2',
      stopTarget: { kind: 'turn' as const, turnId: 'turn-2' },
      prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision }
    }
    expect(
      await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
    ).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(dismissPrompt).toHaveBeenCalledWith(expect.objectContaining({ answer: true }))
    expect(cancelTurn).not.toHaveBeenCalled()
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    const card = page.ok ? page.page.items.find((item) => item.itemId === prompt.itemId) : null
    expect(card?.body).toMatchObject({ resolution: { state: 'cancelled' } })
  }
)
