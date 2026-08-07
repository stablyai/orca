import { describe, expect, it } from 'vitest'
import {
  CONDITIONAL_INJECT_SCHEMA,
  canonicalConditionalInjectRequest,
  digestConditionalInjectRequest,
  type ConditionalInjectDigestInput
} from './conditional-inject-digest'

const input: ConditionalInjectDigestInput = {
  schema: CONDITIONAL_INJECT_SCHEMA,
  attemptId: '11111111-1111-4111-8111-111111111111',
  taskId: 'task_1',
  dagNodeId: '22222222-2222-4222-8222-222222222222',
  payload: '한글 payload',
  coordinator: { handle: 'term_coord', pane: 'tab:coord' },
  worker: { handle: 'term_worker', pane: 'tab:worker', worktreeId: 'repo::/worktree' },
  runtimeId: 'runtime-1'
}

describe('conditional inject digest', () => {
  it('uses sorted UTF-8 JSON and lowercase SHA-256', () => {
    expect(canonicalConditionalInjectRequest(input)).toBe(
      '{"attemptId":"11111111-1111-4111-8111-111111111111","coordinator":{"handle":"term_coord","pane":"tab:coord"},"dagNodeId":"22222222-2222-4222-8222-222222222222","payload":"한글 payload","runtimeId":"runtime-1","schema":"orca.conditional-dispatch-inject.v1","taskId":"task_1","worker":{"handle":"term_worker","pane":"tab:worker","worktreeId":"repo::/worktree"}}'
    )
    expect(digestConditionalInjectRequest(input)).toMatch(/^[0-9a-f]{64}$/)
    expect(digestConditionalInjectRequest(input)).toBe(
      '30321a96c3e5d983232ae601364047c7154fa32baf0789bd93ec7564d563ae0c'
    )
  })
})
