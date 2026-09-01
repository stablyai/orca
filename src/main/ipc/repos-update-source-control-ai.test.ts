// repos:update Source Control AI override boundary: repo action-override
// agentIds are persisted agent references and must follow the field-level
// stale-reference write rule (L1-#1) — a changed id must be a currently
// enabled live identity; invalid changes preserve the stored value.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomTuiAgent, CustomTuiAgentId, GlobalSettings, Repo } from '../../shared/types'

const { handleMock, mockStore } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    getRepo: vi.fn(),
    updateRepo: vi.fn(),
    getSettings: vi.fn()
  }
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: vi.fn()
  }
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([]),
  BASE_REF_SEARCH_ARGS: ['for-each-ref'],
  filterBaseRefSearchOutput: vi.fn().mockReturnValue([])
}))

vi.mock('./filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

vi.mock('./worktree-base-directory-watcher', () => ({
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: vi.fn()
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn()
}))

import { registerRepoHandlers } from './repos'

const UUID_A = '01234567-89ab-4cde-8f01-23456789abcd'
const UUID_B = 'fedcba98-7654-4321-8fed-cba987654321'

function customId(base: string, uuid: string): CustomTuiAgentId {
  return `custom-agent:${base}:${uuid}` as CustomTuiAgentId
}

const liveId = customId('codex', UUID_A)
const deadId = customId('codex', UUID_B)

function liveAgent(): CustomTuiAgent {
  return { id: liveId, baseAgent: 'codex', label: 'My Codex', args: '', env: {}, syncEnv: false }
}

function settingsWith(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    defaultTuiAgent: 'auto',
    disabledTuiAgents: [],
    customTuiAgents: [liveAgent()],
    deletedCustomTuiAgents: [{ id: deadId, baseAgent: 'codex', label: 'Gone', deletedAt: 1 }],
    ...overrides
  } as GlobalSettings
}

function repoWith(sourceControlAi?: Repo['sourceControlAi']): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...(sourceControlAi ? { sourceControlAi } : {})
  } as Repo
}

describe('repos:update sourceControlAi action-override agent references', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }

  function update(sourceControlAi: unknown): unknown {
    return handlers.get('repos:update')!(null, { repoId: 'repo-1', updates: { sourceControlAi } })
  }

  function persistedOverrides(): Record<string, { agentId?: unknown }> | undefined {
    const updates = mockStore.updateRepo.mock.calls.at(-1)?.[1] as {
      sourceControlAi?: { actionOverrides?: Record<string, { agentId?: unknown }> }
    }
    return updates.sourceControlAi?.actionOverrides
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mainWindow.webContents.send.mockReset()
    mockStore.getRepo.mockReset().mockReturnValue(repoWith())
    mockStore.getSettings.mockReset().mockReturnValue(settingsWith())
    mockStore.updateRepo
      .mockReset()
      .mockImplementation((_id: string, updates: Partial<Repo>) => ({ ...repoWith(), ...updates }))

    registerRepoHandlers(mainWindow as never, mockStore as never)
  })

  it('accepts a changed agentId that is a currently enabled live identity', () => {
    update({ actionOverrides: { commitMessage: { agentId: liveId } } })
    expect(persistedOverrides()).toEqual({ commitMessage: { agentId: liveId } })
  })

  it('drops a changed agentId pointing at a tombstoned or never-existed custom id', () => {
    update({
      actionOverrides: {
        commitMessage: { agentId: deadId },
        fixChecks: { agentId: customId('claude', UUID_A), agentArgs: '--safe' }
      }
    })
    const overrides = persistedOverrides()
    // No stored value to preserve: the invalid reference must not persist (it
    // would mint a permanent tombstone via the owner scanner). Other fields stay.
    expect(overrides?.commitMessage).toBeUndefined()
    expect(overrides?.fixChecks).toEqual({ agentArgs: '--safe' })
  })

  it('preserves the stored id when a stale client tries to clobber it with an invalid one', () => {
    mockStore.getRepo.mockReturnValue(
      repoWith({ actionOverrides: { commitMessage: { agentId: liveId } } })
    )
    update({ actionOverrides: { commitMessage: { agentId: deadId } } })
    expect(persistedOverrides()).toEqual({ commitMessage: { agentId: liveId } })
  })

  it('lets a stored stale reference be echoed back unchanged while other fields save', () => {
    // The stored reference is itself tombstoned (stale) — resubmitting the exact
    // stored value is a no-op, never an error, so unrelated edits still save.
    mockStore.getRepo.mockReturnValue(
      repoWith({ actionOverrides: { commitMessage: { agentId: deadId } } })
    )
    update({
      actionOverrides: { commitMessage: { agentId: deadId, commandInputTemplate: '{basePrompt}!' } }
    })
    expect(persistedOverrides()).toEqual({
      commitMessage: { agentId: deadId, commandInputTemplate: '{basePrompt}!' }
    })
  })

  it('rejects a changed agentId whose identity is disabled, preserving the stored value', () => {
    mockStore.getSettings.mockReturnValue(settingsWith({ disabledTuiAgents: ['codex'] }))
    mockStore.getRepo.mockReturnValue(
      repoWith({ actionOverrides: { commitMessage: { agentId: 'claude' } } })
    )
    // Both the disabled built-in and a derivative of the disabled base are rejected.
    update({ actionOverrides: { commitMessage: { agentId: 'codex' } } })
    expect(persistedOverrides()).toEqual({ commitMessage: { agentId: 'claude' } })
    update({ actionOverrides: { commitMessage: { agentId: liveId } } })
    expect(persistedOverrides()).toEqual({ commitMessage: { agentId: 'claude' } })
  })

  it('still allows explicit null (clear) and the custom-command sentinel', () => {
    mockStore.getRepo.mockReturnValue(
      repoWith({ actionOverrides: { commitMessage: { agentId: liveId } } })
    )
    update({ actionOverrides: { commitMessage: { agentId: null } } })
    expect(persistedOverrides()).toEqual({ commitMessage: { agentId: null } })
    update({ actionOverrides: { commitMessage: { agentId: 'custom' } } })
    expect(persistedOverrides()).toEqual({ commitMessage: { agentId: 'custom' } })
  })
})
