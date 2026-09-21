import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'worktree-1',
  repoId: repo.id,
  path: '/worktree',
  head: 'abc',
  branch: 'feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

type StartupArgs = Parameters<typeof startRuntimeLocalWorktreeTerminals>[0]

function createPorts() {
  const createTerminal = vi.fn<StartupArgs['ports']['createTerminal']>().mockResolvedValue({
    handle: 'term-1',
    worktreeId: worktree.id,
    title: null
  })
  const ports: StartupArgs['ports'] = {
    canSpawn: true,
    markTrusted: vi.fn(),
    createTerminal,
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    provision: vi.fn().mockResolvedValue({ setupSpawned: false, setupTerminalHandle: null }),
    activate: vi.fn()
  }
  return { createTerminal, ports }
}

describe('startRuntimeLocalWorktreeTerminals default shell seeding', () => {
  it.each([
    ['Blank Terminal', undefined, 1],
    ['an agent', 'codex' as const, 0]
  ])('seeds a background shell for %s selection only', async (_label, agent, expectedCalls) => {
    const { createTerminal, ports } = createPorts()

    await startRuntimeLocalWorktreeTerminals({
      request: { repoSelector: `id:${repo.id}`, name: worktree.displayName },
      repo,
      worktree,
      ...(agent ? { createdWithAgent: agent } : {}),
      ports
    })

    expect(createTerminal).toHaveBeenCalledTimes(expectedCalls)
    if (expectedCalls > 0) {
      expect(createTerminal).toHaveBeenCalledWith(`id:${worktree.id}`, { surfaceOwner: false })
    }
  })
})
