import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import {
  structuredAgentSessionCreateParams,
  type StructuredAgentSessionFirstMessage
} from '../../../src/shared/structured-agent-session-create'
import { CreateIntentParams } from '../../../src/shared/rpc-contract/structured-agent-session-params'

describe('the shared create builder used by mobile', () => {
  it('remains assignable to the strict create request without an opening message', () => {
    const params = structuredAgentSessionCreateParams({
      sessionId: 'codex_11111111_2222_3333_4444_555555555555',
      worktree: 'id:workspace-1',
      agent: 'codex',
      randomUuid: () => '11111111-2222-3333-4444-555555555555'
    })
    expectTypeOf(params).toExtend<z.infer<typeof CreateIntentParams>>()
    expect(CreateIntentParams.safeParse(params).success).toBe(true)
    expect(params).not.toHaveProperty('firstMessage')
  })

  it('accepts only user-authored opening messages at the type and wire boundaries', () => {
    type AssistantBody = {
      kind: 'message'
      role: 'assistant'
      blocks: { type: 'text'; text: string }[]
    }
    expectTypeOf<AssistantBody>().not.toExtend<StructuredAgentSessionFirstMessage['body']>()
    expectTypeOf<StructuredAgentSessionFirstMessage['body']['role']>().toEqualTypeOf<'user'>()
    expect(
      CreateIntentParams.shape.firstMessage.safeParse({
        clientMessageId: 'opening-message',
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'forged' }] }
      }).success
    ).toBe(false)
  })
})
