/**
 * Drives the real publication seam: a real OrcaRuntimeService answering the same session-tabs call
 * the client subscribes through. The window's own unit tests can only prove it answers correctly
 * once asked -- they cannot prove the runtime asks it, or asks it per client.
 */
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

  // The two-client bug: one desktop attaching used to close the window for everyone, so the second
  // desktop's next snapshot looked authoritative and it culled rows for guests it was still running.
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

  // The fan-out sites (`emitMobileSessionTabsSnapshot`, the notify loops) share this one seam, and
  // the projection census in client-hosted-page-reconciliation-window.test.ts is what keeps them
  // from growing a second, unheld path.
})
