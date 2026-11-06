import { describe, expect, it } from 'vitest'
import type { AgentWorkspaceTrustDecision } from '../../../shared/agent-workspace-trust-decision'
import type { AgentTrustSpawnFields } from './agent-workspace-trust'
import { applyAgentWorkspaceTrustToSpawn } from './agent-workspace-trust-spawn'

// An SSH launch only forwards the request to the relay, so no local config is written.
async function sshTrustRequest(input: {
  worktreeId: string
  globalEnabled?: boolean
  repoDecision?: AgentWorkspaceTrustDecision
  skipForThisLaunch?: boolean
}): Promise<AgentTrustSpawnFields> {
  const spawnOptions: AgentTrustSpawnFields = {}
  await applyAgentWorkspaceTrustToSpawn({
    launchAgent: 'claude',
    skipForThisLaunch: input.skipForThisLaunch,
    worktreeId: input.worktreeId,
    cwd: '/srv/app',
    store: {
      getFolderWorkspace: () => ({ folderPath: '/srv/folder' }),
      getRepo: (repoId) =>
        repoId === 'repo-1' && input.repoDecision
          ? { agentWorkspaceTrust: input.repoDecision }
          : undefined
    },
    isFreshLaunch: true,
    settings: { agentWorkspaceTrustEnabled: input.globalEnabled ?? true },
    env: {},
    claudeAuth: null,
    wslDistro: null,
    connectionId: 'ssh-1',
    spawnOptions
  })
  return spawnOptions
}

describe('agent folder trust follows the repo decision', () => {
  it('pre-trusts a repo whose decision is pre-trust', async () => {
    expect(
      await sshTrustRequest({ worktreeId: 'repo-1::/srv/app', repoDecision: 'pre-trust' })
    ).toEqual({ agentWorkspaceTrust: { workspacePath: '/srv/app' } })
  })

  it('leaves the folder untrusted when the repo lets agents ask', async () => {
    expect(
      await sshTrustRequest({ worktreeId: 'repo-1::/srv/app', repoDecision: 'agent-asks' })
    ).toEqual({})
  })

  it('keeps pre-trust for an undecided repo so unattended launches never wait', async () => {
    expect(await sshTrustRequest({ worktreeId: 'repo-1::/srv/app' })).toEqual({
      agentWorkspaceTrust: { workspacePath: '/srv/app' }
    })
  })

  it('never pre-trusts when folder trust is off globally', async () => {
    expect(
      await sshTrustRequest({
        worktreeId: 'repo-1::/srv/app',
        globalEnabled: false,
        repoDecision: 'pre-trust'
      })
    ).toEqual({})
  })

  it("honours this launch's let-agents-ask answer even when the repo has none stored", async () => {
    expect(
      await sshTrustRequest({ worktreeId: 'repo-1::/srv/app', skipForThisLaunch: true })
    ).toEqual({})
  })
})
