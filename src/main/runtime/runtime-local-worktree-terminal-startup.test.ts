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

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

async function startupTerminalOptions(startupPaneKey?: string) {
  const { createTerminal, ports } = createPorts()
  await startRuntimeLocalWorktreeTerminals({
    request: {
      repoSelector: `id:${repo.id}`,
      name: worktree.displayName,
      ...(startupPaneKey ? { startupPaneKey } : {})
    },
    repo,
    worktree,
    createdWithAgent: 'codex',
    startup: { command: 'codex' },
    ports
  })
  return createTerminal.mock.calls[0]?.[1] ?? {}
}

describe('startRuntimeLocalWorktreeTerminals reserved startup pane', () => {
  // The local, folder and remote creates each forward this separately, so nothing above them
  // catches the one that stops.
  it('creates the startup terminal under the pane the caller reserved', async () => {
    expect(await startupTerminalOptions(`${TAB_ID}:${LEAF_ID}`)).toMatchObject({
      tabId: TAB_ID,
      leafId: LEAF_ID
    })
  })

  it('leaves the pane to the runtime when none was reserved', async () => {
    const options = await startupTerminalOptions()
    expect(options).not.toHaveProperty('tabId')
    expect(options).not.toHaveProperty('leafId')
  })
})

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
