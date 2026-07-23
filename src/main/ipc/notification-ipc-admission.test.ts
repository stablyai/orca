import { describe, expect, it } from 'vitest'
import {
  MAX_NOTIFICATION_DISPATCH_INPUT_BYTES,
  normalizeNotificationDispatchRequest
} from './notification-ipc-admission'

describe('notification IPC admission', () => {
  it('copies only whitelisted fields so unknown payloads are not retained', () => {
    const request = normalizeNotificationDispatchRequest({
      source: 'agent-task-complete',
      worktreeId: 'repo::worktree',
      requireDisplayConfirmation: true,
      unknownPayload: 'x'.repeat(MAX_NOTIFICATION_DISPATCH_INPUT_BYTES * 2)
    })

    expect(request).toEqual({
      source: 'agent-task-complete',
      worktreeId: 'repo::worktree',
      requireDisplayConfirmation: true
    })
    expect(request).not.toHaveProperty('unknownPayload')
  })

  it('rejects non-boolean control fields', () => {
    for (const field of [
      'requireDisplayConfirmation',
      'hasMultipleActiveRepos',
      'isActiveWorktree',
      'agentInterrupted'
    ]) {
      expect(
        normalizeNotificationDispatchRequest({
          source: 'agent-task-complete',
          [field]: 'true'
        })
      ).toBeNull()
    }
  })

  it('enforces the aggregate UTF-8 budget across known string fields', () => {
    expect(
      normalizeNotificationDispatchRequest({
        source: 'agent-task-complete',
        agentPrompt: '😀'.repeat(MAX_NOTIFICATION_DISPATCH_INPUT_BYTES / 8),
        agentLastAssistantMessage: '😀'.repeat(MAX_NOTIFICATION_DISPATCH_INPUT_BYTES / 8)
      })
    ).toBeNull()
  })
})
