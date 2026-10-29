import { describe, expect, it } from 'vitest'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'
import { WorktreeCreate } from '../../../../shared/rpc-contract/worktree-create-params'

const PROVENANCE = {
  automationProvenance: undefined,
  cliProvenance: undefined,
  creatorProvenance: { kind: 'host' as const }
}

const build = (params: Record<string, unknown>) =>
  buildManagedWorktreeCreateArgs(WorktreeCreate.parse(params), PROVENANCE)

describe('buildManagedWorktreeCreateArgs', () => {
  it('carries explicit existing intent through the RPC schema without inferring it for legacy names', () => {
    const request = {
      repo: 'repo-1',
      name: 'feature/test',
      baseBranch: 'origin/main',
      branchNameOverride: 'feature/test'
    }
    expect(build(request)).not.toHaveProperty('branchIntent')
    for (const branchIntent of ['open-existing', 'open-existing-v2', 'create-new']) {
      expect(build({ ...request, branchIntent })).toMatchObject({ branchIntent })
    }
  })

  it('omits name provenance when the client did not claim a generated name', () => {
    // Absent means user-typed: default true would permanently retire deliberate names such as orca and molly.
    expect(build({ repo: 'id:repo-1', name: 'nautilus' })).not.toHaveProperty('nameWasGenerated')
    expect(
      build({ repo: 'id:repo-1', name: 'nautilus', nameWasGenerated: false })
    ).not.toHaveProperty('nameWasGenerated')
  })

  it('forwards the flag when the client fell back to a generated name', () => {
    expect(build({ repo: 'id:repo-1', name: 'nautilus', nameWasGenerated: true })).toMatchObject({
      nameWasGenerated: true
    })
  })

  it('keeps the legacy CLI marker on a name-only create request', () => {
    const args = buildManagedWorktreeCreateArgs(
      WorktreeCreate.parse({ repo: 'id:repo-1', name: 'feature' }),
      { ...PROVENANCE, cliProvenance: { kind: 'created-by-cli', createdAt: 1 } }
    )

    expect(args).toMatchObject({
      name: 'feature',
      cliProvenance: { kind: 'created-by-cli', createdAt: 1 }
    })
    expect(args.displayName).toBeUndefined()
  })

  it('carries the parent-pick provenance only when the client marked it manual', () => {
    // Older clients omit this and retain CLI-flag behavior.
    expect(
      build({ repo: 'id:repo-1', name: 'child', parentWorkspace: 'folder:f1' }).lineage
    ).not.toHaveProperty('parentWorkspaceOrigin')
    expect(
      build({
        repo: 'id:repo-1',
        name: 'child',
        parentWorkspace: 'folder:f1',
        parentWorkspaceOrigin: 'manual'
      }).lineage
    ).toMatchObject({ parentWorkspaceOrigin: 'manual' })
  })

  it('lets a person-driven create fall back to a local base, but not an automation run', () => {
    expect(build({ repo: 'id:repo-1', name: 'feature' })).toMatchObject({
      allowLocalBaseFallback: true
    })
    const automationRun = buildManagedWorktreeCreateArgs(
      WorktreeCreate.parse({ repo: 'id:repo-1', name: 'nightly' }),
      {
        ...PROVENANCE,
        automationProvenance: {
          kind: 'created-by-automation',
          automationId: 'automation-1',
          automationNameSnapshot: 'Nightly',
          automationRunId: 'run-1',
          automationRunTitleSnapshot: 'Nightly run',
          createdAt: 1,
          executionTargetType: 'local',
          executionTargetId: 'local',
          projectId: 'repo-1'
        }
      }
    )
    expect(automationRun).not.toHaveProperty('allowLocalBaseFallback')
    // E9: a person's create may start a stopped WSL distro for its terminals; an automation's never.
    expect(build({ repo: 'id:repo-1', name: 'feature' })).toMatchObject({ wslUserAct: true })
    expect(automationRun).not.toHaveProperty('wslUserAct')
  })
})

describe('worktree setup choice', () => {
  it.each([false, true])('preserves the submitted choice across RPC (%s)', (setupOnly) => {
    const params = WorktreeCreate.parse({ repo: 'repo-1', name: 'choice', setupOnly })
    expect(buildManagedWorktreeCreateArgs(params, {})).toMatchObject({ setupOnly })
  })
})
