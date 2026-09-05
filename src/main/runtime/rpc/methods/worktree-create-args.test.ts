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
  it.each(['', 'codex'])('preserves explicit background startup for command %j', (command) => {
    expect(
      build({
        repo: 'repo',
        startupCommand: command,
        startupActivate: false,
        activate: false
      })
    ).toMatchObject({ startup: { command, activate: false }, activate: false })
  })

  it('preserves caller completion flags for a host-built draft startup', () => {
    expect(
      build({
        repo: 'repo',
        startupDraft: 'task',
        startupActivate: false,
        awaitTerminalProvisioning: true
      })
    ).toMatchObject({
      startupDraft: 'task',
      startupActivate: false,
      awaitTerminalProvisioning: true
    })
  })

  it('leaves provisioning and startup override absent for legacy callers', () => {
    const args = build({ repo: 'repo', startupDraft: 'task' })
    expect(args).not.toHaveProperty('startupActivate')
    expect(args).not.toHaveProperty('awaitTerminalProvisioning')
  })

  it('keeps legacy empty-command and absent-command requests free of startup', () => {
    expect(build({ repo: 'repo', startupCommand: '' }).startup).toBeUndefined()
    expect(build({ repo: 'repo', startupActivate: false }).startup).toBeUndefined()
  })

  it('does not change foreground intent for existing agent clients', () => {
    const args = build({ repo: 'repo', startupCommand: 'codex', activate: true })
    expect(args.activate).toBe(true)
    expect(args.startup).toEqual({ command: 'codex' })
  })

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
})
