import { describe, expect, it } from 'vitest'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'
import { WorktreeCreate } from './worktree-create-schemas'
import { InvalidArgumentError } from '../core'

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

  it('forwards per-launch model and effort for the startup agent', () => {
    expect(
      build({
        repo: 'id:repo-1',
        name: 'task',
        startupAgent: 'codex',
        startupLaunchPreferences: { model: 'gpt-5.6-sol', effort: 'high' }
      })
    ).toMatchObject({
      startupAgent: 'codex',
      startupLaunchPreferences: { model: 'gpt-5.6-sol', effort: 'high' }
    })
    expect(build({ repo: 'id:repo-1', name: 'task', startupAgent: 'codex' })).not.toHaveProperty(
      'startupLaunchPreferences'
    )
  })

  it('refuses an effort the startup agent model does not offer', () => {
    // Why: the same catalog check worker-start runs, so a typo fails before a checkout exists
    // instead of launching the agent on a setting it never applied.
    const refused = () =>
      build({
        repo: 'id:repo-1',
        name: 'task',
        startupAgent: 'codex',
        startupLaunchPreferences: { model: 'gpt-5.5', effort: 'max' }
      })
    expect(refused).toThrow(InvalidArgumentError)
    expect(refused).toThrow('Agent codex model gpt-5.5 does not support effort max.')
  })

  it('requires a startup agent for launch preferences', () => {
    expect(
      WorktreeCreate.safeParse({
        repo: 'id:repo-1',
        name: 'task',
        startupLaunchPreferences: { model: 'gpt-5.6-sol' }
      }).success
    ).toBe(false)
  })
})
