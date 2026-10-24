import { describe, expect, it, vi } from 'vitest'
import {
  observeStructuredAutomationRunCompletion,
  parseStructuredAutomationRunHandle,
  structuredAutomationRunHandle
} from './runtime-structured-run-observer'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'

describe('runtime-structured-run-observer', () => {
  it('round-trips structured automation run handles', () => {
    const handle = structuredAutomationRunHandle('sess-123')
    expect(parseStructuredAutomationRunHandle(handle)).toBe('sess-123')
    expect(parseStructuredAutomationRunHandle('term_123')).toBeNull()
  })

  it('completes when the structured session turn settles with success and captures assistant prose', async () => {
    let settled = false
    const subState: { emit: ((event: AgentSessionTurnCompletionEvent) => void) | null } = {
      emit: null
    }
    const host = {
      journalSnapshot: vi.fn(async () => ({
        items: settled
          ? [
              {
                itemId: 'user-1',
                revision: 1,
                body: {
                  kind: 'message',
                  role: 'user',
                  blocks: [{ type: 'text', text: 'Run checks' }]
                }
              },
              {
                itemId: 'assistant-1',
                revision: 1,
                body: {
                  kind: 'message',
                  role: 'assistant',
                  blocks: [{ type: 'text', text: 'Checks succeeded with 0 warnings.' }]
                }
              },
              {
                itemId: 'turn-1',
                revision: 2,
                body: {
                  kind: 'status',
                  turnLifecycle: {
                    turnId: 'turn-1',
                    state: 'completed',
                    outcome: 'success',
                    startedAt: 100,
                    completedAt: 200
                  }
                }
              }
            ]
          : [
              {
                itemId: 'turn-1',
                revision: 1,
                body: {
                  kind: 'status',
                  turnLifecycle: {
                    turnId: 'turn-1',
                    state: 'running',
                    startedAt: 100
                  }
                }
              }
            ],
        submissions: []
      })),
      subscribeTurnCompletions: vi.fn(
        (sub: { emit: (event: AgentSessionTurnCompletionEvent) => void }) => {
          subState.emit = sub.emit
          return () => {
            subState.emit = null
          }
        }
      )
    }

    const controller = new AbortController()
    const observationPromise = observeStructuredAutomationRunCompletion({
      sessionId: 'sess-1',
      signal: controller.signal,
      since: 100,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test stub implements only the members read by the observer.
      getHost: () => host as never
    })

    await vi.waitFor(() => expect(subState.emit).not.toBeNull())
    settled = true
    subState.emit?.({
      type: 'completion',
      completion: {
        scope: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'wt-1',
          workspaceKind: 'git-worktree'
        },
        sessionId: 'sess-1',
        turnId: 'turn-1',
        outcome: 'success',
        completedAt: 200
      }
    })

    const observation = await observationPromise
    expect(observation).toEqual({
      status: 'completed',
      outputSnapshot: expect.objectContaining({
        format: 'plain_text',
        content: 'Checks succeeded with 0 warnings.',
        truncated: false
      }),
      error: null
    })
  })

  it('reports dispatch_failed when the structured turn settles with failure', async () => {
    const host = {
      journalSnapshot: vi.fn(async () => ({
        items: [
          {
            itemId: 'turn-1',
            revision: 2,
            body: {
              kind: 'status',
              turnLifecycle: {
                turnId: 'turn-1',
                state: 'completed',
                outcome: 'failure',
                startedAt: 100,
                completedAt: 200
              }
            }
          }
        ],
        submissions: []
      })),
      subscribeTurnCompletions: vi.fn(() => () => {})
    }

    const observation = await observeStructuredAutomationRunCompletion({
      sessionId: 'sess-1',
      signal: new AbortController().signal,
      since: 100,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test stub implements only the members read by the observer.
      getHost: () => host as never
    })

    expect(observation).toEqual({
      status: 'dispatch_failed',
      outputSnapshot: null,
      error: 'Automation structured session turn ended with failure.'
    })
  })

  it('settles a confirmed interrupted turn without provider outcome as dispatch_failed', async () => {
    const host = {
      journalSnapshot: vi.fn(async () => ({
        items: [
          {
            itemId: 'turn-crashed',
            revision: 2,
            body: {
              kind: 'turn',
              turnId: 'turn-crashed',
              state: 'interrupted',
              startedAt: 100,
              completedAt: 200
            }
          }
        ],
        submissions: []
      })),
      subscribeTurnCompletions: vi.fn(() => () => {})
    }

    const observation = await observeStructuredAutomationRunCompletion({
      sessionId: 'sess-crashed',
      signal: new AbortController().signal,
      since: 100,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test stub implements only the members read by the observer.
      getHost: () => host as never
    })

    expect(observation).toEqual({
      status: 'dispatch_failed',
      outputSnapshot: null,
      error: 'Automation structured session turn ended with interruption.'
    })
  })
})
