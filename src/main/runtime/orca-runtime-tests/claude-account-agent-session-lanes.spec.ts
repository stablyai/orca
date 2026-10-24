import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'
import { resolveRuntimeSpawnClaudeAccount } from '../../ipc/pty/runtime/spawn-claude-account'
import type { RuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import type { RuntimePtyController } from '../runtime-pty-controller-contract'

type PtySpawnOptions = Parameters<NonNullable<RuntimePtyController['spawn']>>[0]

const PROJECT_ACCOUNT = 'acct-project'

function pinnedProjectStore() {
  const repos = store.getRepos().map((repo) => ({
    ...repo,
    agentAccounts: { claude: { mode: 'account' as const, accountId: PROJECT_ACCOUNT } }
  }))
  return {
    ...store,
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getSettings: () => ({
      ...store.getSettings(),
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    })
  }
}

function spawningRuntime() {
  const runtimeStore = pinnedProjectStore()
  const spawn = vi.fn(async (options: PtySpawnOptions) => ({
    id: `pty-${spawn.mock.calls.length}`,
    ...(options.agentSessionEnsure
      ? {
          agentSessionEnsure: {
            disposition: 'created' as const,
            owner: {
              ...options.agentSessionEnsure,
              generation: 'generation-1',
              phase: 'live' as const,
              ptyId: `pty-${spawn.mock.calls.length}`
            }
          }
        }
      : {})
  }))
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  Object.assign(runtime, { markWorkspaceTrustedForAgent: vi.fn(async () => {}) })
  // Runs the spawn lane's own account resolution on exactly what the runtime handed the PTY.
  const spawnAccount = (call: number): string | undefined => {
    const ctx = {
      args: spawn.mock.calls[call]![0],
      deps: { store: runtimeStore },
      preAdoptedStablePane: null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveRuntimeSpawnClaudeAccount reads only args, deps.store and preAdoptedStablePane.
    return resolveRuntimeSpawnClaudeAccount(ctx as unknown as RuntimePtySpawnState)
  }
  return { runtime, spawn, spawnAccount }
}

describe('Claude account on host agent-session launches', () => {
  it.each([
    [ACTIVE_CLAUDE_ACCOUNT, undefined],
    ['acct-2', 'acct-2'],
    [undefined, PROJECT_ACCOUNT]
  ])(
    'spawns a paired create and resume carrying %s on account %s',
    async (claudeAccountId, expected) => {
      const { runtime, spawn, spawnAccount } = spawningRuntime()
      await runtime.createAgentSession(
        {
          clientOperationId: `${Date.now()}-${'cd'.repeat(16)}`,
          worktree: `id:${TEST_WORKTREE_ID}`,
          agent: 'claude',
          prompt: '',
          presentation: 'background',
          ...(claudeAccountId ? { claudeAccountId } : {})
        },
        { clientId: 'paired-1', clientKind: 'runtime' }
      )
      await runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: `id:${TEST_WORKTREE_ID}`,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'provider-session-1' },
        ...(claudeAccountId ? { claudeAccountId } : {})
      })
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(spawnAccount(0)).toBe(expected)
      expect(spawnAccount(1)).toBe(expected)
    }
  )
})
