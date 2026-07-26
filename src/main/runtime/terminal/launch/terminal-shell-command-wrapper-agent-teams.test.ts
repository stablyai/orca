import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { makeStore } from '../../rpc/server/runtime-rpc-worktree-store-fixtures'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const WORKTREE_PATH = '/tmp/worktree-a'

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/shell-wrapper',
      isBare: false,
      isMainWorktree: false
    }
  ]
  const createWorktreeListingMocks = () => ({
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

describe('shell command wrapper and Claude Agent Teams', () => {
  it('does not treat a shell command wrapper as Agent Teams setup sequencing', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const base = makeStore()
    const runtime = new OrcaRuntimeService({
      ...base,
      getSettings: () => ({
        ...base.getSettings(),
        claudeAgentTeamsMode: 'in-process' as const,
        shellCommandWrapper: 'devenv shell -- $CMD'
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      command: "claude 'hello'",
      launchAgent: 'claude',
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: {}
      }
    })

    const launched = spawn.mock.calls[0]?.[0] as {
      command?: string
      env?: Record<string, string>
    }

    // Why: wrapper alone must not queue SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV
    // (which would spawn the unenhanced source command and drop teammate mode).
    expect(launched.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]).toBeUndefined()
    expect(launched.command).toBe("devenv shell -- claude --teammate-mode in-process 'hello'")
    expect(launched.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
  })
})
