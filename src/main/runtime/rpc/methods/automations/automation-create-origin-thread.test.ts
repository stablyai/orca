import { describe, expect, it, vi } from 'vitest'

const ORIGIN = {
  source: 'slack',
  externalId: 'T1:C08NLB8LXCP:1795700000.000100',
  place: '#ui-ux-design',
  sessionId: 'thread-chat'
} as const

// The caller's chat answers that thread; reading it needs the live connector seam.
vi.mock('./creator-thread', () => ({ creatorThreadOf: async () => ORIGIN }))
vi.mock('../../../automation-saved-card', () => ({ recordAutomationSavedCard: () => {} }))

import { AUTOMATION_METHODS } from './automations'

async function create(params: Record<string, unknown>) {
  const createAutomation = vi.fn(async (input: { bot?: unknown }) => ({ id: 'a1', ...input }))
  const runtime = { createAutomation, lookAround: { botOfLook: () => null } }
  const method = AUTOMATION_METHODS.find((entry) => entry.name === 'automation.create')!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members
  await method.handler({ callerSessionId: 'thread-chat', ...params } as never, { runtime } as never)
  return createAutomation.mock.calls[0]![0]
}

describe('creating a bot automation while answering a thread', () => {
  it('records that thread on one events start, so its deadline run answers there', async () => {
    const saved = await create({
      name: 'Nora replies',
      prompt: 'Tell me when Nora replies.',
      bot: { botId: 'b1', runsIn: 'new', resultsTo: 'thread' },
      on: [{ id: 'e1', source: 'slack', event: 'message' }],
      once: { by: 2 }
    })
    expect(saved.bot).toEqual({
      botId: 'b1',
      runsIn: 'new',
      resultsTo: 'thread',
      originThread: ORIGIN
    })
  })
})
