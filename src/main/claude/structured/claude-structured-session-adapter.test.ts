import { describe, expect, it } from 'vitest'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import { acquired, fakeClaude, tick } from './claude-structured-session-test-support'
import { invokeCanUseTool } from '../claude-can-use-tool-test-support'

describe('ClaudeStructuredSessionAdapter prompts', () => {
  it('leaves a prompt cancelled and unanswerable once the SDK abort signal fires', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    const controller = new AbortController()
    const answered = invokeCanUseTool(claude.connections[0], 'Bash', 'permission-9', 'tool-9', {
      input: { command: 'rm -rf /' },
      signal: controller.signal
    })
    adapter.bindPromptItemId('session-1', 'journal-9', 'permission-9')

    controller.abort()
    await expect(answered.promise).resolves.toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'prompt-cancelled', promptKey: 'permission-9' })
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'journal-9',
        kind: 'approval',
        response: { kind: 'option', optionId: 'allow' },
        fence: 7,
        commit: async () => undefined
      })
    ).rejects.toThrow(/no longer waiting/)
  })

  it('settles an in-flight permission callback when the session closes, leaving no dangling promise', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude)
    const answered = invokeCanUseTool(claude.connections[0], 'Bash', 'permission-close', 'tool-c', {
      input: { command: 'ls' }
    })
    await tick()
    expect(answered.settled()).toBe(false)

    await adapter.closeSession('session-1')

    await expect(answered.promise).resolves.toBeNull()
  })
})
