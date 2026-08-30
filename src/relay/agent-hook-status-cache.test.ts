import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { applyRelayHookEvent } from './agent-hook-status-cache'
import { reconcileRelayCodexEvent } from './agent-hook-codex-reconciliation'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function event(
  hookEventName: string,
  reconcileDiagnostic?: AgentHookEventPayload['reconcileDiagnostic']
): AgentHookEventPayload {
  return {
    paneKey: PANE_KEY,
    source: 'codex',
    connectionId: null,
    hookEventName,
    ...(reconcileDiagnostic !== undefined ? { reconcileDiagnostic } : {}),
    payload: { state: 'working', prompt: 'prompt', agentType: 'codex' }
  }
}

describe('relay agent-hook status cache', () => {
  it('restores working when a newer parent turn follows a historical completion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-status-cache-'))
    try {
      const transcriptPath = join(dir, 'rollout-parent.jsonl')
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`
      )
      const state = createHookListenerState()

      const reconciled = reconcileRelayCodexEvent(
        state,
        {
          ...event('PostToolUse'),
          providerSession: { key: 'session_id', id: 'session-1', transcriptPath },
          payload: {
            state: 'done',
            prompt: 'prompt',
            agentType: 'codex',
            subagents: [
              {
                id: '019fa65f-3144-7151-9c02-cff7a28f316f',
                state: 'working',
                startedAt: 1234
              }
            ]
          }
        },
        { reconcileParentState: true }
      )

      expect(reconciled.payload.state).toBe('working')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves persisted waits while reconciling historical nonterminal records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-status-cache-waiting-'))
    try {
      const transcriptPath = join(dir, 'rollout-parent.jsonl')
      const childId = '019fa65f-3144-7151-9c02-cff7a28f316f'
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify(
          {
            type: 'event_msg',
            payload: {
              type: 'sub_agent_activity',
              occurred_at_ms: 1234,
              agent_thread_id: childId,
              agent_path: '/root/waiting_child',
              kind: 'started'
            }
          }
        )}\n`
      )
      writeFileSync(
        join(dir, `rollout-child-${childId}.jsonl`),
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`
      )
      const state = createHookListenerState()

      const reconciled = reconcileRelayCodexEvent(
        state,
        {
          ...event('PostToolUse'),
          providerSession: { key: 'session_id', id: 'session-1', transcriptPath },
          payload: {
            state: 'waiting',
            prompt: 'permission',
            agentType: 'codex',
            subagents: [{ id: childId, state: 'waiting', startedAt: 1234 }]
          }
        },
        { reconcileParentState: true }
      )

      expect(reconciled.payload.state).toBe('waiting')
      expect(reconciled.payload.subagents?.[0]?.state).toBe('waiting')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not rewrite a live turn from a historical parent terminal record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-status-cache-live-turn-'))
    try {
      const transcriptPath = join(dir, 'rollout-parent.jsonl')
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      )
      const state = createHookListenerState()
      const live = {
        ...event('UserPromptSubmit'),
        providerSession: { key: 'session_id' as const, id: 'session-1', transcriptPath }
      }

      expect(reconcileRelayCodexEvent(state, live).payload.state).toBe('working')
      const restart = reconcileRelayCodexEvent(state, live, { reconcileParentState: true })
      expect(restart.payload.state).toBe('done')
      expect(restart.codexAuthoritativeParentState).toBe('done')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['working', 'waiting'] as const)(
    'keeps the aggregate %s when the parent completed before a child',
    (childState) => {
      const dir = mkdtempSync(join(tmpdir(), 'relay-hook-status-cache-active-child-'))
      try {
        const transcriptPath = join(dir, 'rollout-parent.jsonl')
        const childId = '019fa65f-3144-7151-9c02-cff7a28f316f'
        writeFileSync(
          transcriptPath,
          `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify(
            {
              type: 'event_msg',
              payload: {
                type: 'sub_agent_activity',
                occurred_at_ms: 1234,
                agent_thread_id: childId,
                agent_path: '/root/active_child',
                kind: 'started'
              }
            }
          )}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
        )
        writeFileSync(
          join(dir, `rollout-child-${childId}.jsonl`),
          `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`
        )
        const state = createHookListenerState()

        const reconciled = reconcileRelayCodexEvent(
          state,
          {
            ...event('PostToolUse'),
            providerSession: { key: 'session_id', id: 'session-1', transcriptPath },
            payload: {
              state: childState,
              prompt: 'prompt',
              agentType: 'codex',
              subagents: [{ id: childId, state: childState, startedAt: 1234 }]
            }
          },
          { reconcileParentState: true }
        )

        expect(reconciled.codexAuthoritativeParentState).toBe('done')
        expect(reconciled.payload.state).toBe(childState)
        expect(reconciled.payload.subagents).toEqual([
          expect.objectContaining({ id: childId, state: childState })
        ])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it('does not claim an authoritative roster when an initial read skips old parent history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-status-cache-long-parent-'))
    try {
      const transcriptPath = join(dir, 'rollout-parent.jsonl')
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'ignored', payload: 'x'.repeat(1024 * 1024) })}\n${JSON.stringify(
          { type: 'event_msg', payload: { type: 'task_started' } }
        )}\n`
      )
      const state = createHookListenerState()
      const reconciled = reconcileRelayCodexEvent(
        state,
        {
          ...event('PostToolUse'),
          providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
        },
        { reconcileParentState: true }
      )

      expect(reconciled.codexSubagentsAuthoritative).toBeUndefined()
      expect(reconciled.codexAuthoritativeParentState).toBe('working')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops seeded roster authority when more than one read window arrives between polls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-status-cache-parent-gap-'))
    try {
      const transcriptPath = join(dir, 'rollout-parent.jsonl')
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`
      )
      const state = createHookListenerState()
      const initial = reconcileRelayCodexEvent(state, {
        ...event('PostToolUse'),
        codexSubagentsAuthoritative: true,
        providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
      })
      expect(initial.codexSubagentsAuthoritative).toBe(true)

      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify({ type: 'ignored', payload: 'x'.repeat(1024 * 1024) })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      )
      const afterGap = reconcileRelayCodexEvent(
        state,
        {
          ...event('PostToolUse'),
          providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
        },
        { reconcileParentState: true }
      )

      expect(afterGap.codexSubagentsAuthoritative).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clears an inherited Codex reconciliation diagnostic at SessionStart', () => {
    const state = createHookListenerState()
    const metadata = new Map<string, { source: 'codex' }>()
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const options = {
      state,
      previous: undefined,
      source: 'codex' as const,
      metadata,
      persist: vi.fn(),
      clearPaneState: vi.fn(),
      forward
    }

    applyRelayHookEvent({
      ...options,
      event: event('PostToolUse', {
        kind: 'unverifiable',
        reason: 'transcript-unreadable',
        observedAt: 100
      })
    })
    const previous = state.lastStatusByPaneKey.get(PANE_KEY)
    expect(previous?.reconcileDiagnostic).toBeDefined()

    applyRelayHookEvent({
      ...options,
      previous,
      event: event('SessionStart')
    })

    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.reconcileDiagnostic).toBeNull()
    expect(forward.mock.calls.at(-1)?.[0].reconcileDiagnostic).toBeNull()
  })
})
