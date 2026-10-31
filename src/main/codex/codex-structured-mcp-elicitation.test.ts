import { describe, expect, it } from 'vitest'
import {
  acquireReadyCodexForTest,
  THREAD_ID,
  adapterFor,
  fakeCodex,
  identityFor,
  lifecycleRecorder
} from './codex-structured-session-adapter-fixture'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import { readCodexMcpElicitation } from './codex-mcp-elicitation'

const recordedElicitations = z
  .array(
    z.object({
      id: z.union([z.string(), z.number()]),
      method: z.string(),
      params: z.record(z.string(), z.unknown())
    })
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL('./__fixtures__/codex-app-server-mcp-elicitations.json', import.meta.url),
        'utf8'
      )
    )
  )

async function elicitationSession(mode: 'url' | 'form', cancellationAdmitted = true) {
  const frame = recordedElicitations.find((frame) => frame.params.mode === mode)
  if (!frame) {
    throw new Error('Missing recorded elicitation')
  }
  const codex = fakeCodex()
  const recorded = lifecycleRecorder(cancellationAdmitted)
  const adapter = adapterFor(codex)
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: recorded.sink
  })
  const request = { ...frame, params: { ...frame.params, threadId: THREAD_ID, turnId: 'turn-1' } }
  codex.connections[0].handlers.onServerRequest?.(request)
  const cards = [...recorded.bodies].flatMap(([id, body]) =>
    body.kind === 'approval' || body.kind === 'question' ? [{ id, body }] : []
  )
  const answer = async (id: string, response: AgentSessionPromptResponse) => {
    const body = recorded.bodies.get(id)
    if (!body || (body.kind !== 'approval' && body.kind !== 'question')) {
      throw new Error('Missing card')
    }
    return adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: id,
      kind: body.kind,
      fence: 7,
      response,
      commit: async () => {
        recorded.bodies.set(id, {
          ...body,
          resolution: {
            state: 'resolved',
            selectedOptionId: response.kind === 'option' ? response.optionId : null,
            ...(response.kind === 'form' ? { formContent: response.content } : {}),
            resolvedBy: 'client',
            resolvedAt: 1
          }
        })
      }
    })
  }
  return { codex, adapter, recorded, cards, request, answer }
}

describe('recorded MCP elicitation contracts', () => {
  it.each(['accept', 'decline', 'cancel'])(
    'journals URL requests and replies %s once to their outer id',
    async (action) => {
      const { codex, cards, request, answer } = await elicitationSession('url')
      expect(cards).toHaveLength(1)
      expect(cards[0]?.body).toMatchObject({
        kind: 'approval',
        detail: request.params.url,
        url: request.params.url
      })
      expect(codex.connections[0].replies).toEqual([])
      const id = cards[0]!.id
      await answer(id, { kind: 'option', optionId: action })
      expect(codex.connections[0].replies).toEqual([
        { id: request.id, result: { action, content: null, _meta: null } }
      ])
      await expect(answer(id, { kind: 'option', optionId: action })).rejects.toThrow(
        'no longer waiting'
      )
      expect(codex.connections[0].replies).toHaveLength(1)
    }
  )

  it('accepts one complete typed form and keeps invalid content editable before commit', async () => {
    const { codex, cards, request, recorded, answer } = await elicitationSession('form')
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card.body.kind).toBe('approval')
    expect(card.body.options.map((option) => option.id)).toEqual(['decline', 'cancel'])
    const content = { name: '  ', count: 0, confirmed: false, color: 'blue', note: '' }
    await expect(
      answer(card.id, { kind: 'form', content: { ...content, count: 11 } })
    ).rejects.toThrow('at most 10')
    expect(recorded.bodies.get(card.id)?.resolution.state).toBe('pending')
    expect(codex.connections[0].replies).toEqual([])
    await answer(card.id, { kind: 'form', content })
    expect(codex.connections[0].replies).toEqual([
      { id: request.id, result: { action: 'accept', content, _meta: null } }
    ])
    await expect(answer(card.id, { kind: 'form', content })).rejects.toThrow('no longer waiting')
    expect(codex.connections[0].replies).toHaveLength(1)
  })

  it.each(['decline', 'cancel'])('ends an unfilled form explicitly with %s', async (action) => {
    const { codex, cards, request, answer } = await elicitationSession('form')
    await answer(cards[0]!.id, { kind: 'option', optionId: action })
    expect(codex.connections[0].replies).toEqual([
      { id: request.id, result: { action, content: null, _meta: null } }
    ])
  })

  it('declines the whole request before showing unsupported or truncated field schemas', () => {
    const fixture = recordedElicitations.find((frame) => frame.params.mode === 'form')!
    for (const schema of [
      { type: 'object', properties: { x: { type: 'object' } } },
      { type: 'object', properties: { x: { type: 'string', pattern: '.*' } } },
      {
        type: 'object',
        properties: { x: { type: 'string', enum: Array.from({ length: 63 }, (_, i) => String(i)) } }
      },
      { type: 'object', properties: { x: { type: 'number', minimum: 2, maximum: 1 } } },
      { type: 'object', properties: { x: { type: 'string', enum: ['a', 'a'] } } }
    ]) {
      expect(readCodexMcpElicitation({ ...fixture.params, requestedSchema: schema })).toBeNull()
    }
  })
})
