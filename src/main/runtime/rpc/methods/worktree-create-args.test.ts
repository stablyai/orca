import { describe, expect, it } from 'vitest'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'
import { WorktreeCreate } from './worktree-create-schemas'

const PROVENANCE = {
  automationProvenance: undefined,
  cliProvenance: undefined,
  creatorProvenance: { kind: 'host' as const }
}

const build = (params: Record<string, unknown>) =>
  buildManagedWorktreeCreateArgs(WorktreeCreate.parse(params), PROVENANCE)

describe('buildManagedWorktreeCreateArgs', () => {
  it('omits name provenance when the client did not claim a generated name', () => {
    // Why: absent must mean user-typed. A truthy default would let the host permanently retire
    // names people chose on purpose — the pool contains ordinary words like "orca" and "molly".
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

  it('carries the parent-pick provenance only when the client marked it manual', () => {
    // Why: older clients never send it, and those creates really are CLI-flag equivalents.
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
})
