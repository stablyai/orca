import { describe, expect, it } from 'vitest'
import { mergeWorktree } from './worktree-logic'
import type { GitWorktreeInfo, WorktreeMeta } from '../../shared/types'

const GIT: GitWorktreeInfo = {
  path: '/workspaces/feature',
  head: 'abc123',
  branch: 'refs/heads/feature-x',
  isBare: false,
  isMainWorktree: false
}

const BASE_META: WorktreeMeta = {
  displayName: '',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

describe('mergeWorktree creation agent metadata', () => {
  it('forwards the creation agent metadata', () => {
    const result = mergeWorktree('repo1', GIT, { ...BASE_META, createdWithAgent: 'codex' })

    expect(result.createdWithAgent).toBe('codex')
  })
})

describe('mergeWorktree recovery-card projection', () => {
  it('mirrors the client-safe launch failure + pending record without leaking secrets', () => {
    const result = mergeWorktree('repo1', GIT, {
      ...BASE_META,
      agentLaunchFailure: {
        version: 1,
        failureId: 'fail-1',
        intent: 'interactive',
        occurredAt: 42,
        code: 'spawn_failed',
        requestedAgent: 'custom-agent:codex:abc',
        baseAgent: 'codex'
      },
      pendingAgentLaunch: { operationId: 'op-1', requestedAgent: 'codex', priorFailureId: 'fail-0' }
    })

    expect(result.agentLaunchFailure).toEqual({
      version: 1,
      failureId: 'fail-1',
      intent: 'interactive',
      occurredAt: 42,
      code: 'spawn_failed',
      requestedAgent: 'custom-agent:codex:abc',
      baseAgent: 'codex'
    })
    expect(result.pendingAgentLaunch).toEqual({
      operationId: 'op-1',
      requestedAgent: 'codex',
      priorFailureId: 'fail-0'
    })
    // The Worktree DTO crosses RPC to mobile/paired clients: the recovery-card
    // mirrors must never carry the private launch snapshot, token, argv, env, or
    // resolved path.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/launchToken|snapshot|agentEnv|argv|launchConfig/)
  })

  it('omits both fields when the worktree has no pending launch or failure', () => {
    const result = mergeWorktree('repo1', GIT, BASE_META)

    expect(result).not.toHaveProperty('agentLaunchFailure')
    expect(result).not.toHaveProperty('pendingAgentLaunch')
  })
})
