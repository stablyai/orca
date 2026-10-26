/** Exercise runtime publication per client; window-unit coverage alone cannot prove callers apply the hold. */
import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'
const DEVICE_A = 'device-a'
const DEVICE_B = 'device-b'

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

function createRuntime(): OrcaRuntimeService {
  let session: WorkspaceSessionState = {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  return new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  })
}

describe('client-hosted reconciliation hold on published session tabs', () => {
  it('warns a freshly started runtime has not taken its client-hosted pages back yet', async () => {
    const runtime = createRuntime()

    const answer = await runtime.listMobileSessionTabs(`id:${WT}`, DEVICE_A)

    expect(answer.clientHostedPagesUnreconciled).toBe(true)
  })

  it('drops the warning for the client whose host attached', async () => {
    const runtime = createRuntime()

    runtime.markClientHostedPagesReconciled(DEVICE_A)

    const answer = await runtime.listMobileSessionTabs(`id:${WT}`, DEVICE_A)
    expect(answer.clientHostedPagesUnreconciled).toBeUndefined()
  })

  // One client's attach cannot authorize another to cull its still-live browser rows.
  it('keeps warning the client whose host has not attached', async () => {
    const runtime = createRuntime()

    runtime.markClientHostedPagesReconciled(DEVICE_A)

    expect(
      (await runtime.listMobileSessionTabs(`id:${WT}`, DEVICE_A)).clientHostedPagesUnreconciled
    ).toBe(undefined)
    expect(
      (await runtime.listMobileSessionTabs(`id:${WT}`, DEVICE_B)).clientHostedPagesUnreconciled
    ).toBe(true)

    runtime.markClientHostedPagesReconciled(DEVICE_B)

    expect(
      (await runtime.listMobileSessionTabs(`id:${WT}`, DEVICE_B)).clientHostedPagesUnreconciled
    ).toBe(undefined)
  })
})
