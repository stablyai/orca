import { loadAutomationTargets, workspaceMatchesSetup } from './automation-target-inventory'
import { describe, expect, it } from 'vitest'
import { automationDraftPatch, newAutomationDraft } from './automation-draft'

import { automationClient, automationTargets } from './automation-test-fixtures'

describe('mobile automation host contracts', () => {
  it('resolves legacy inventory only from a unique repo host and never assumes local', async () => {
    const setup = automationTargets().setups[0]!
    let repos: {
      id: string
      path: string
      displayName: string
      connectionId: string | null
    }[] = [{ id: setup.repoId, path: setup.path, displayName: 'Local', connectionId: null }]
    const port = automationClient((method) => {
      if (method === 'project.list') {
        return { projects: [] }
      }
      if (method === 'projectHostSetup.list') {
        return { setups: [setup] }
      }
      if (method === 'repo.list') {
        return { repos }
      }
      if (method === 'ssh.listTargetSummaries') {
        return { targets: [] }
      }
      if (method === 'worktree.list') {
        return {
          worktrees: [
            { id: 'legacy', repoId: setup.repoId, path: setup.path, displayName: 'Legacy' }
          ],
          totalCount: 1,
          truncated: false,
          hostScope: { hostIds: ['local'], omittedHostIds: [] }
        }
      }
      throw new Error(method)
    })
    const local = await loadAutomationTargets(port.client)
    expect(local.workspaces[0]?.hostId).toBe('local')
    expect(workspaceMatchesSetup(local.workspaces[0]!, setup)).toBe(true)
    repos = [{ ...repos[0]!, connectionId: 'builder' }]
    const remote = await loadAutomationTargets(port.client)
    expect(remote.workspaces[0]?.hostId).toBe('ssh:builder')
    expect(workspaceMatchesSetup(remote.workspaces[0]!, setup)).toBe(false)
    repos.push({ ...repos[0]!, connectionId: null })
    expect((await loadAutomationTargets(port.client)).workspaces).toEqual([])
    repos = []
    expect((await loadAutomationTargets(port.client)).workspaces).toEqual([])
  })
})

describe('automation setup pin writes', () => {
  const original = { ...newAutomationDraft(), name: 'Nightly', setupDecision: 'run' as const }

  it('keeps the saved pin on an ordinary edit', () => {
    expect(automationDraftPatch({ ...original, name: 'Renamed' }, original)).toEqual({
      name: 'Renamed'
    })
  })

  it('names the decision when setup was re-approved without a pin', () => {
    expect(automationDraftPatch({ ...original, setupDecisionEdited: true }, original)).toEqual({
      setupDecision: 'run'
    })
  })

  it("re-decides setup when only the base changes, since runs use the new base's setup", () => {
    expect(automationDraftPatch({ ...original, baseBranch: 'release' }, original)).toEqual({
      baseBranch: 'release',
      setupDecision: 'run'
    })
  })
})
