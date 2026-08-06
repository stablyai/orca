import { describe, expect, it, vi } from 'vitest'
import type {
  ClaudeManagedAccount,
  GlobalSettings,
  WorktreeMeta,
  Project
} from '../../shared/types'
import type { Store } from '../persistence'
import type { ClaudeAccountService } from './service'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-service'
import {
  createProjectAwarePrepareClaudeAuth,
  resolveProjectPreferredClaudeAccountId
} from './project-account-preference'

const PREPARATION: ClaudeRuntimeAuthPreparation = {
  configDir: '/home/user/.claude',
  envPatch: {},
  stripAuthEnv: true,
  provenance: 'test'
}

function makeAccount(overrides: Partial<ClaudeManagedAccount> = {}): ClaudeManagedAccount {
  return {
    id: 'acct-b',
    email: 'b@example.com',
    managedAuthPath: '/managed/acct-b',
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

function makeStore(args: {
  worktreeProjectId?: string | null
  project?: Partial<Project> | null
  accounts?: ClaudeManagedAccount[]
  selection?: Partial<
    Pick<GlobalSettings, 'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'>
  >
}): Store {
  const project: Project | null =
    args.project === null
      ? null
      : ({
          id: 'project-1',
          displayName: 'Project',
          badgeColor: '#fff',
          sourceRepoIds: [],
          createdAt: 1,
          updatedAt: 1,
          ...args.project
        } as Project)
  return {
    getWorktreeMeta: vi
      .fn()
      .mockReturnValue(
        args.worktreeProjectId === null
          ? undefined
          : ({ projectId: args.worktreeProjectId ?? 'project-1' } as WorktreeMeta)
      ),
    getProjects: vi.fn().mockReturnValue(project ? [project] : []),
    getSettings: vi.fn().mockReturnValue({
      claudeManagedAccounts: args.accounts ?? [],
      activeClaudeManagedAccountId: args.selection?.activeClaudeManagedAccountId ?? null,
      activeClaudeManagedAccountIdsByRuntime: args.selection?.activeClaudeManagedAccountIdsByRuntime
    } as GlobalSettings)
  } as unknown as Store
}

function makeDeps(store: Store): {
  prepare: ReturnType<typeof vi.fn>
  selectAccountForTarget: ReturnType<typeof vi.fn>
  prepareClaudeAuth: ReturnType<typeof createProjectAwarePrepareClaudeAuth>
} {
  const prepare = vi.fn().mockResolvedValue(PREPARATION)
  const selectAccountForTarget = vi.fn().mockResolvedValue(undefined)
  const prepareClaudeAuth = createProjectAwarePrepareClaudeAuth({
    getStore: () => store,
    getClaudeAccounts: () => ({ selectAccountForTarget }) as unknown as ClaudeAccountService,
    prepare
  })
  return { prepare, selectAccountForTarget, prepareClaudeAuth }
}

describe('resolveProjectPreferredClaudeAccountId', () => {
  it('returns null without a worktree id', () => {
    const store = makeStore({})
    expect(resolveProjectPreferredClaudeAccountId(store, undefined)).toBeNull()
  })

  it('returns null when the worktree has no meta', () => {
    const store = makeStore({ worktreeProjectId: null })
    expect(resolveProjectPreferredClaudeAccountId(store, 'wt-1')).toBeNull()
  })

  it('returns null when the project does not exist', () => {
    const store = makeStore({ project: null })
    expect(resolveProjectPreferredClaudeAccountId(store, 'wt-1')).toBeNull()
  })

  it('returns null when the project has no preference', () => {
    const store = makeStore({ project: {} })
    expect(resolveProjectPreferredClaudeAccountId(store, 'wt-1')).toBeNull()
  })

  it('returns the preferred account id', () => {
    const store = makeStore({
      project: { claudeAccountPreference: { kind: 'account', accountId: 'acct-b' } }
    })
    expect(resolveProjectPreferredClaudeAccountId(store, 'wt-1')).toBe('acct-b')
  })
})

describe('createProjectAwarePrepareClaudeAuth', () => {
  it('passes through without a preference', async () => {
    const store = makeStore({ project: {} })
    const { prepare, selectAccountForTarget, prepareClaudeAuth } = makeDeps(store)

    await expect(prepareClaudeAuth({ runtime: 'host' }, { worktreeId: 'wt-1' })).resolves.toBe(
      PREPARATION
    )
    expect(selectAccountForTarget).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledWith({ runtime: 'host' })
  })

  it('falls back to the global selection when the preferred account no longer exists', async () => {
    const store = makeStore({
      project: { claudeAccountPreference: { kind: 'account', accountId: 'gone' } },
      accounts: [makeAccount()]
    })
    const { prepare, selectAccountForTarget, prepareClaudeAuth } = makeDeps(store)

    await prepareClaudeAuth({ runtime: 'host' }, { worktreeId: 'wt-1' })
    expect(selectAccountForTarget).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalled()
  })

  it('falls back when the preferred account belongs to a different runtime', async () => {
    const store = makeStore({
      project: { claudeAccountPreference: { kind: 'account', accountId: 'acct-b' } },
      accounts: [makeAccount({ managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })]
    })
    const { prepare, selectAccountForTarget, prepareClaudeAuth } = makeDeps(store)

    await prepareClaudeAuth({ runtime: 'host' }, { worktreeId: 'wt-1' })
    expect(selectAccountForTarget).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalled()
  })

  it('falls back when the launch names a different WSL distro', async () => {
    const store = makeStore({
      project: { claudeAccountPreference: { kind: 'account', accountId: 'acct-b' } },
      accounts: [makeAccount({ managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })]
    })
    const { prepare, selectAccountForTarget, prepareClaudeAuth } = makeDeps(store)

    await prepareClaudeAuth({ runtime: 'wsl', wslDistro: 'Debian' }, { worktreeId: 'wt-1' })
    expect(selectAccountForTarget).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalled()
  })

  it('skips the switch when the preferred account is already selected', async () => {
    const store = makeStore({
      project: { claudeAccountPreference: { kind: 'account', accountId: 'acct-b' } },
      accounts: [makeAccount()],
      selection: { activeClaudeManagedAccountId: 'acct-b' }
    })
    const { prepare, selectAccountForTarget, prepareClaudeAuth } = makeDeps(store)

    await prepareClaudeAuth({ runtime: 'host' }, { worktreeId: 'wt-1' })
    expect(selectAccountForTarget).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalled()
  })

  it('switches to the preferred account before preparing', async () => {
    const store = makeStore({
      project: { claudeAccountPreference: { kind: 'account', accountId: 'acct-b' } },
      accounts: [makeAccount()],
      selection: { activeClaudeManagedAccountId: 'acct-a' }
    })
    const { prepare, selectAccountForTarget, prepareClaudeAuth } = makeDeps(store)
    const order: string[] = []
    selectAccountForTarget.mockImplementation(async () => {
      order.push('select')
    })
    prepare.mockImplementation(async () => {
      order.push('prepare')
      return PREPARATION
    })

    await prepareClaudeAuth({ runtime: 'host' }, { worktreeId: 'wt-1' })
    expect(selectAccountForTarget).toHaveBeenCalledWith('acct-b')
    expect(order).toEqual(['select', 'prepare'])
  })

  it('rejects without preparing when the switch fails', async () => {
    const store = makeStore({
      project: { claudeAccountPreference: { kind: 'account', accountId: 'acct-b' } },
      accounts: [makeAccount()],
      selection: { activeClaudeManagedAccountId: 'acct-a' }
    })
    const { prepare, selectAccountForTarget, prepareClaudeAuth } = makeDeps(store)
    selectAccountForTarget.mockRejectedValue(new Error('switch blocked'))

    await expect(prepareClaudeAuth({ runtime: 'host' }, { worktreeId: 'wt-1' })).rejects.toThrow(
      /preferred Claude account.*switch blocked/
    )
    expect(prepare).not.toHaveBeenCalled()
  })
})
