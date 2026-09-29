import { describe, expect, it } from 'vitest'
import { classifyCodexRolloutHeader } from './codex-session-worker-classification'

const line = (type: string, payload: unknown): string => `${JSON.stringify({ type, payload })}\n`
const metadata = line('session_meta', { id: 'session_1' })
const context = line('response_item', {
  type: 'message',
  role: 'user',
  content: [
    { type: 'input_text', text: '# AGENTS.md instructions for /repo' },
    {
      type: 'input_text',
      text: '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>'
    }
  ]
})
const worker = line('response_item', {
  type: 'message',
  role: 'user',
  content: [
    {
      type: 'input_text',
      text: [
        'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.',
        'Your task ID is: task_abc123',
        'orca orchestration send --task-id task_abc123 --dispatch-id ctx_def456'
      ].join('\n')
    }
  ]
})

describe('classifyCodexRolloutHeader', () => {
  it('recognizes a dispatched worker after Codex-injected context', () => {
    expect(classifyCodexRolloutHeader(metadata + context + worker)).toBe('worker')
  })

  it('preserves an ordinary Codex chat', () => {
    const prompt = line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Fix the login form' }]
    })
    expect(classifyCodexRolloutHeader(metadata + context + prompt)).toBe('other')
  })

  it('defers a Codex rollout until its first real prompt is written', () => {
    expect(classifyCodexRolloutHeader(metadata + context)).toBe('pending')
    expect(classifyCodexRolloutHeader(metadata + context + worker.slice(0, 20))).toBe('pending')
  })

  it('keeps legacy or non-Codex fixture files eligible for backfill', () => {
    expect(classifyCodexRolloutHeader('{"type":"session_meta","id":"old"}\n')).toBe('other')
    expect(classifyCodexRolloutHeader('legacy text\n')).toBe('other')
  })
})
