import { describe, expect, it } from 'vitest'
import type { Store } from '../../../persistence/loading-store/store'
import {
  ACTIVE_CLAUDE_ACCOUNT,
  type ProjectClaudeAccountPreference
} from '../../../../shared/claude/project-claude-account-preference'
import { terminalCreateClaudeAccountIdField } from '../../../runtime/terminal/launch/terminal-create-claude-account-field'
import { resolveRuntimeSpawnClaudeAccount } from './spawn-claude-account'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

function storeWithRepo(claude: ProjectClaudeAccountPreference): Store {
  const repo = { id: 'wt-1', agentAccounts: { claude } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveRuntimeSpawnClaudeAccount only reads getRepo; the rest of Store belongs to unrelated persistence callers this test never exercises.
  return { getRepo: (repoId: string) => (repoId === 'wt-1' ? repo : undefined) } as unknown as Store
}

function runtimeCtx(input: {
  args: Partial<RuntimePtySpawnArgs>
  deps?: { store?: Store }
}): ReturnType<typeof createRuntimePtySpawnState> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveRuntimeSpawnClaudeAccount only reads deps.store; the rest of PtyRuntimeControllerDeps belongs to later spawn stages this test never runs.
  const deps = { store: input.deps?.store } as unknown as PtyRuntimeControllerDeps
  return createRuntimePtySpawnState(deps, { cols: 80, rows: 24, ...input.args })
}

describe('resolveRuntimeSpawnClaudeAccount: project account fallback', () => {
  const worktreeId = 'wt-1'

  it('falls back to the project account when no --account is given', () => {
    const ctx = runtimeCtx({
      args: { command: 'claude', launchAgent: 'claude', worktreeId },
      deps: { store: storeWithRepo({ mode: 'account', accountId: 'acct-1' }) }
    })
    expect(resolveRuntimeSpawnClaudeAccount(ctx)).toBe('acct-1')
  })

  it('keeps SSH and non-Claude runtime spawns unpinned by project preference', () => {
    const store = storeWithRepo({ mode: 'account', accountId: 'acct-1' })
    const sshCtx = runtimeCtx({
      args: { command: 'claude', launchAgent: 'claude', worktreeId, connectionId: 'ssh-1' },
      deps: { store }
    })
    const nonClaudeCtx = runtimeCtx({
      args: { command: 'zsh', worktreeId },
      deps: { store }
    })

    expect(() => resolveRuntimeSpawnClaudeAccount(sshCtx)).not.toThrow()
    expect(resolveRuntimeSpawnClaudeAccount(sshCtx)).toBeUndefined()
    expect(() => resolveRuntimeSpawnClaudeAccount(nonClaudeCtx)).not.toThrow()
    expect(resolveRuntimeSpawnClaudeAccount(nonClaudeCtx)).toBeUndefined()
  })

  it('honors the launch config account over the project default, including "active this time"', () => {
    const store = storeWithRepo({ mode: 'account', accountId: 'acct-1' })
    const resolveFor = (launchConfigClaudeAccountId: string) =>
      resolveRuntimeSpawnClaudeAccount(
        runtimeCtx({
          args: {
            command: 'claude --resume s-1',
            launchAgent: 'claude',
            worktreeId,
            ...terminalCreateClaudeAccountIdField({
              launchConfig: { claudeAccountId: launchConfigClaudeAccountId }
            })
          },
          deps: { store }
        })
      )

    expect(resolveFor(ACTIVE_CLAUDE_ACCOUNT)).toBeUndefined()
    expect(resolveFor('acct-2')).toBe('acct-2')
  })
})

describe('resolveRuntimeSpawnClaudeAccount: explicit --account', () => {
  it('refuses SSH and non-Claude launches, and accepts a gated Claude setup launch', () => {
    const resolve = (args: Partial<RuntimePtySpawnArgs>) =>
      resolveRuntimeSpawnClaudeAccount(runtimeCtx({ args: { claudeAccountId: 'acct-2', ...args } }))

    expect(() => resolve({ command: 'claude', connectionId: 'ssh-1' })).toThrow(
      'Claude --account launches are not supported for SSH workspaces.'
    )
    expect(() => resolve({ command: 'zsh' })).toThrow('--account applies only to Claude launches.')
    expect(resolve({ command: 'pnpm setup', launchAgent: 'claude' })).toBe('acct-2')
  })
})
