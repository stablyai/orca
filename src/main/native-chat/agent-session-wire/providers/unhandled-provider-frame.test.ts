import { describe, expect, it } from 'vitest'
import { unhandledProviderFrameJournalItem } from './unhandled-provider-frame'
import { AGENT_SESSION_HOOK_FAILED_PRESENTATION } from '../../../../shared/agent-session/journal/agent-session-hook-outcome'
import { structuredAgentSessionStatusBlock } from '../../../../shared/agent-session/view/structured-agent-session-status-block'
import { nativeChatTurnFoldRow } from '../../../../shared/native-chat/transcript/folding/native-chat-turn-fold'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

function codexHookCompletedFrame(overrides: {
  eventName: string
  status: string
  entries?: unknown[]
}): Record<string, unknown> {
  return {
    threadId: '00000000-0000-4000-8000-000000000001',
    turnId: '00000000-0000-4000-8000-000000000002',
    run: {
      id: `${overrides.eventName}:1:/tmp/hooks.json`,
      eventName: overrides.eventName,
      handlerType: 'command',
      executionMode: 'sync',
      scope: 'turn',
      sourcePath: '/tmp/hooks.json',
      source: 'user',
      displayOrder: 1,
      status: overrides.status,
      statusMessage: null,
      startedAt: 1792445343,
      completedAt: 1792445343,
      durationMs: 12,
      entries: overrides.entries ?? []
    }
  }
}

const HOOK_EXIT_ERROR = { kind: 'error', text: 'hook exited with code 1.' }

describe('unhandledProviderFrameJournalItem hook failures', () => {
  it('marks a failed Codex Stop hook as a hook failure that keeps its answer', () => {
    const item = unhandledProviderFrameJournalItem(
      'codex',
      'notification:hook/completed',
      codexHookCompletedFrame({ eventName: 'stop', status: 'failed', entries: [HOOK_EXIT_ERROR] })
    )
    expect(item).not.toBeNull()
    expect(item?.classification).toBe('error-surface')
    expect(item?.body).toMatchObject({
      kind: 'status',
      tone: 'error',
      presentation: AGENT_SESSION_HOOK_FAILED_PRESENTATION,
      text: 'Codex Stop hook failed: hook exited with code 1.'
    })
  })

  it('leaves a failed non-Stop Codex hook without the Stop-hook marker', () => {
    const item = unhandledProviderFrameJournalItem(
      'codex',
      'notification:hook/completed',
      codexHookCompletedFrame({
        eventName: 'preToolUse',
        status: 'failed',
        entries: [HOOK_EXIT_ERROR]
      })
    )
    expect(item?.body).toMatchObject({ kind: 'status', tone: 'error' })
    expect(item?.body.presentation).toBeUndefined()
  })

  it('marks a failed Claude Stop hook as a hook failure that keeps its answer', () => {
    const item = unhandledProviderFrameJournalItem('claude', 'message:system:hook_response', {
      hook_name: 'Stop',
      outcome: 'error',
      exit_code: 1,
      stderr: 'boom'
    })
    expect(item).not.toBeNull()
    expect(item?.classification).toBe('error-surface')
    expect(item?.body).toMatchObject({
      kind: 'status',
      tone: 'error',
      presentation: AGENT_SESSION_HOOK_FAILED_PRESENTATION,
      text: 'Claude Stop hook failed (exit code 1): boom'
    })
  })

  it('leaves a failed non-Stop Claude hook without the Stop-hook marker', () => {
    const item = unhandledProviderFrameJournalItem('claude', 'message:system:hook_response', {
      hook_name: 'PreToolUse',
      outcome: 'error',
      exit_code: 2,
      stderr: 'nope'
    })
    expect(item?.body).toMatchObject({ kind: 'status', tone: 'error' })
    expect(item?.body.presentation).toBeUndefined()
  })

  it('still suppresses a successful Codex hook completion', () => {
    const item = unhandledProviderFrameJournalItem(
      'codex',
      'notification:hook/completed',
      codexHookCompletedFrame({ eventName: 'stop', status: 'succeeded' })
    )
    expect(item).toBeNull()
  })

  it('carries the marker through the status block the fold reads', () => {
    const item = unhandledProviderFrameJournalItem(
      'codex',
      'notification:hook/completed',
      codexHookCompletedFrame({ eventName: 'stop', status: 'failed', entries: [HOOK_EXIT_ERROR] })
    )
    expect(item).not.toBeNull()
    const message: NativeChatMessage = {
      id: 'stop-hook-row',
      role: 'system',
      timestamp: 1,
      source: 'transcript',
      blocks: [structuredAgentSessionStatusBlock(item?.body ?? { kind: 'status', text: '' })]
    }
    const facts = nativeChatTurnFoldRow(message, 'turn-1', false)
    expect(facts.reportsFailure).toBe(false)
    expect(facts.explainsTurn).toBe(true)
  })
})
