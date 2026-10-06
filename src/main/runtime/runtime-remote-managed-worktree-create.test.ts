/** The startup terminal an SSH-remote create spawns; each create path forwards a reserved pane itself. */

import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeSetupLaunch } from '../../shared/worktree/launch-types'
import { SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV } from '../../shared/setup-agent-sequencing'

const requestRuntimeRemoteWorktree = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      worktree: { id: string; path: string }
      setup?: WorktreeSetupLaunch
    }> => ({ worktree: { id: 'wt-remote', path: '/remote/wt' } })
  )
)

vi.mock('./runtime-remote-worktree-create-request', () => ({ requestRuntimeRemoteWorktree }))

const { createRuntimeRemoteManagedWorktree } =
  await import('./runtime-remote-managed-worktree-create')

type CreateParams = Parameters<typeof createRuntimeRemoteManagedWorktree>

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1,
  connectionId: 'conn-1'
}

function createDeps() {
  const createTerminal = vi
    .fn<CreateParams[2]['createTerminal']>()
    .mockResolvedValue({ handle: 'term-1' })
  const deps: CreateParams[2] = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create only forwards the store to the mocked request helper, which never reads it.
    store: {} as unknown as CreateParams[2]['store'],
    canSpawn: () => true,
    createTerminal,
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    provision: vi.fn().mockResolvedValue({ setupSpawned: false, setupTerminalHandle: null }),
    activate: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyWorktreesChanged: vi.fn()
  }
  return { createTerminal, deps }
}

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

async function startupTerminalOptions(startupPaneKey?: string): Promise<Record<string, unknown>> {
  const { createTerminal, deps } = createDeps()
  await createRuntimeRemoteManagedWorktree(
    repo,
    {
      name: 'task',
      createdWithAgent: 'codex',
      startup: { command: 'codex' },
      ...(startupPaneKey ? { startupPaneKey } : {})
    },
    deps
  )
  return createTerminal.mock.calls[0]?.[1] ?? {}
}

describe('a remote managed create with a startup agent', () => {
  it.each([true, false])(
    'preserves setup script through remote provisioning and fallback (activate=%s)',
    async (activate) => {
      requestRuntimeRemoteWorktree.mockResolvedValueOnce({
        worktree: { id: 'wt-remote', path: '/remote/wt' },
        setup: {
          runnerScriptPath: '/remote/repo/.git/orca/setup-runner.sh',
          envVars: { ORCA_ROOT_PATH: '/remote/repo' },
          waitForAgentStartup: true
        }
      })
      const { deps } = createDeps()
      const result = await createRuntimeRemoteManagedWorktree(
        repo,
        {
          name: 'task',
          createdWithAgent: 'codex',
          startup: { command: 'printf agent-ready' },
          activate,
          awaitTerminalProvisioning: true
        },
        deps
      )
      const provisioned = vi.mocked(deps.provision).mock.calls[0]?.[0]
      expect(provisioned?.wrappedSetupCommand).toBe(
        `bash -lc 'eval "$ORCA_SEQUENCED_SETUP_SCRIPT"'`
      )
      expect(provisioned?.setup?.envVars).toEqual({
        ORCA_ROOT_PATH: '/remote/repo',
        [SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV]: expect.stringContaining(
          'bash /remote/repo/.git/orca/setup-runner.sh'
        )
      })
      expect(result.setup?.envVars).toEqual(provisioned?.setup?.envVars)
      expect(result.setup?.command).toBe(provisioned?.wrappedSetupCommand)
    }
  )
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
