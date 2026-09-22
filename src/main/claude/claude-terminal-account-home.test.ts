import { describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  resolveClaudeTerminalConfigDirEnv,
  terminalAgentReadsClaudeConfigDir,
  type ClaudeTerminalHomeLocation
} from './claude-terminal-account-home'

const GROUP_ID = 'group-uniqcast'
const FOLDER_ID = 'folder-workspace-1'
const WORKSPACE_ID = `folder:${FOLDER_ID}`
const BOUND_DIR = '/Users/dev/.claude-uniqcast'

function storeWith(claudeConfigDir: string | null) {
  return {
    hasHydratedProjectCatalog: () => true,
    getProjectGroups: () => [
      { id: GROUP_ID, name: 'uniqcast', parentGroupId: null, claudeConfigDir }
    ],
    getRepos: () => [],
    getFolderWorkspaces: () => [{ id: FOLDER_ID, projectGroupId: GROUP_ID }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only the fields above; a fuller row would add nothing the assertions check.
}

const LOCAL_LOCATION: ClaudeTerminalHomeLocation = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId: WORKSPACE_ID
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    agent: 'claude' as const,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see storeWith.
    store: storeWith(BOUND_DIR) as never,
    location: LOCAL_LOCATION,
    launchEnv: {} as NodeJS.ProcessEnv,
    readSelectedConfigDir: () => undefined,
    assertBoundHomeUsable: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe('terminalAgentReadsClaudeConfigDir', () => {
  it('covers both Claude launchers and nothing else', () => {
    expect(terminalAgentReadsClaudeConfigDir('claude')).toBe(true)
    // The teams launcher runs the same binary behind a shim, so it must honour the same binding.
    expect(terminalAgentReadsClaudeConfigDir('claude-agent-teams')).toBe(true)
    expect(terminalAgentReadsClaudeConfigDir('codex')).toBe(false)
    expect(terminalAgentReadsClaudeConfigDir(null)).toBe(false)
  })
})

describe('resolveClaudeTerminalConfigDirEnv', () => {
  it('pins a bound group home on a local Claude terminal launch', async () => {
    await expect(resolveClaudeTerminalConfigDirEnv(baseInput())).resolves.toEqual({
      CLAUDE_CONFIG_DIR: BOUND_DIR
    })
  })

  it('leaves a non-Claude agent alone', async () => {
    await expect(resolveClaudeTerminalConfigDirEnv(baseInput({ agent: 'codex' }))).resolves.toEqual(
      {}
    )
  })

  it('does NOT pin the selected managed account when no group binds one', async () => {
    // The account selector swaps per-account auth, not the config dir. Pinning it here would fork
    // Claude's shared chat/session context, which is a different bug — not a stricter fix.
    const env = await resolveClaudeTerminalConfigDirEnv(
      baseInput({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see storeWith.
        store: storeWith(null) as never,
        readSelectedConfigDir: () => '/Users/dev/Library/Application Support/orca/accounts/a/auth'
      })
    )
    expect(env).toEqual({})
  })

  it('emits nothing for a binding that names the CLI default home', async () => {
    // A no-op binding must not move the CLI off its default Keychain item.
    const env = await resolveClaudeTerminalConfigDirEnv(
      baseInput({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see storeWith.
        store: storeWith(join(homedir(), '.claude')) as never
      })
    )
    expect(env).toEqual({})
  })

  it('leaves remote and WSL workspaces on their own account rather than refusing', async () => {
    const assertBoundHomeUsable = vi.fn()
    for (const location of [
      { executionHostId: 'ssh:box', wslDistro: null, workspaceId: WORKSPACE_ID },
      { executionHostId: LOCAL_EXECUTION_HOST_ID, wslDistro: 'Ubuntu', workspaceId: WORKSPACE_ID }
    ]) {
      await expect(
        resolveClaudeTerminalConfigDirEnv(baseInput({ location, assertBoundHomeUsable }))
      ).resolves.toEqual({})
    }
    expect(assertBoundHomeUsable).not.toHaveBeenCalled()
  })

  it('refuses rather than falling back when the bound home is unusable', async () => {
    const assertBoundHomeUsable = vi.fn().mockRejectedValue(new Error('claude_bound_home_missing'))
    await expect(
      resolveClaudeTerminalConfigDirEnv(baseInput({ assertBoundHomeUsable }))
    ).rejects.toThrow('claude_bound_home_missing')
  })
})
