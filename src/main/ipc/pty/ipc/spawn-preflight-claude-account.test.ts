import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../../shared/claude/project-claude-account-preference'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth-service'
import { CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE } from '../../../claude-accounts/environment'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from '../../../claude-accounts/live-pty-gate'
import { registerSshPtyProvider, unregisterSshPtyProvider } from '../provider/registry'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { createPtyIpcSpawnState, type PtyIpcSpawnState } from './spawn-state'
import type { AdoptStablePaneResult, PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))

const WORKTREE_ID = 'repo-1::/work/repo-1'

const PINNED_PREPARATION: ClaudeRuntimeAuthPreparation = {
  configDir: '/managed/acct-1',
  envPatch: { CLAUDE_CONFIG_DIR: '/managed/acct-1' },
  stripAuthEnv: true,
  provenance: 'managed:acct-1:pinned',
  pinnedAccountId: 'acct-1'
}

function buildPreflightCtx(input: {
  args: Partial<PtySpawnIpcArgs>
  prepareClaudeAuth: PtySpawnIpcDeps['prepareClaudeAuth']
  adoptedStablePane?: AdoptStablePaneResult
}): PtyIpcSpawnState {
  const repo = { id: 'repo-1', agentAccounts: { claude: { mode: 'account', accountId: 'acct-1' } } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight and env assembly only read the members stubbed here; the rest belong to later spawn stages this test never runs.
  const deps = {
    prepareClaudeAuth: input.prepareClaudeAuth,
    store: { getRepo: (repoId: string) => (repoId === 'repo-1' ? repo : undefined) },
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    assertFolderWorkspacePtyPathUsable: vi.fn(),
    adoptStablePane: vi.fn(async () => input.adoptedStablePane ?? null),
    resolvePtySpawnStartupCwd: (_worktreeId: string | undefined, cwd: string | undefined) => cwd,
    localStartupCwdDirectoryExists: () => true,
    prepareCodexResumeHome: () => null,
    noCodexResumeLaunch: (command: string | undefined) => ({ command }),
    stripSequencedStartupResumeArgv: (env: Record<string, string> | undefined) => env
  } as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, {
    cols: 80,
    rows: 24,
    worktreeId: WORKTREE_ID,
    ...input.args
  })
  if (input.adoptedStablePane) {
    ctx.earlyStablePaneOwner = input.adoptedStablePane.owner
    ctx.earlyWorktreeId = WORKTREE_ID
  }
  return ctx
}

describe('renderer pty spawn preflight: project Claude account', () => {
  afterEach(() => {
    endClaudeAuthSwitch()
    unregisterSshPtyProvider('ssh-1')
  })

  it('pins a fresh Claude launch to the project account', async () => {
    const prepareClaudeAuth = vi.fn(async () => PINNED_PREPARATION)
    const ctx = buildPreflightCtx({
      args: { command: 'claude', launchAgent: 'claude' },
      prepareClaudeAuth
    })

    await preparePtyIpcSpawnPreflight(ctx)

    expect(prepareClaudeAuth).toHaveBeenCalledWith(expect.anything(), { accountId: 'acct-1' })
    expect(ctx.claudeAuth?.pinnedAccountId).toBe('acct-1')
  })

  it('leaves non-Claude, SSH and reattach spawns unpinned', async () => {
    const prepareClaudeAuth = vi.fn(async () => PINNED_PREPARATION)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight only checks the provider's identity; this SSH spawn never reaches provider.spawn.
    registerSshPtyProvider('ssh-1', { spawn: vi.fn() } as never)
    const adoptedStablePane: AdoptStablePaneResult = {
      result: { id: 'pty-adopted' },
      owner: { tabId: 'tab-1', leafId: 'leaf-1', ptyId: 'pty-adopted' }
    }
    const variants = [
      buildPreflightCtx({ args: { command: 'zsh' }, prepareClaudeAuth }),
      buildPreflightCtx({
        args: { command: 'claude', launchAgent: 'claude', connectionId: 'ssh-1' },
        prepareClaudeAuth
      }),
      buildPreflightCtx({
        args: { command: 'claude', launchAgent: 'claude' },
        prepareClaudeAuth,
        adoptedStablePane
      })
    ]

    for (const ctx of variants) {
      await preparePtyIpcSpawnPreflight(ctx)
      expect(ctx.claudeAuth).toBeNull()
    }
    expect(prepareClaudeAuth).not.toHaveBeenCalled()
  })

  it('does not block a pinned launch on a global switch in progress through env assembly', async () => {
    const prepareClaudeAuth = vi.fn(async () => PINNED_PREPARATION)
    beginClaudeAuthSwitch()
    const pinned = buildPreflightCtx({
      args: { command: 'claude', launchAgent: 'claude' },
      prepareClaudeAuth
    })
    const unpinned = buildPreflightCtx({
      args: {
        command: 'claude',
        launchAgent: 'claude',
        launchConfig: { agentArgs: '', agentEnv: {}, claudeAccountId: ACTIVE_CLAUDE_ACCOUNT }
      },
      prepareClaudeAuth
    })

    await expect(preparePtyIpcSpawnPreflight(pinned)).resolves.toBeUndefined()
    await expect(assemblePtyIpcSpawnEnv(pinned)).resolves.toBeUndefined()
    await expect(preparePtyIpcSpawnPreflight(unpinned)).rejects.toThrow(
      CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE
    )
    expect(pinned.claudeAuth?.pinnedAccountId).toBe('acct-1')
    expect(pinned.baseEnv?.CLAUDE_CONFIG_DIR).toBe('/managed/acct-1')
  })
})
