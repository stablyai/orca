import { describe, expect, it } from 'vitest'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'
import { AgentLaunch, AgentLaunchReplay } from '../../../../shared/rpc-contract/agent-launch-params'
import { WorktreeCreate } from '../../../../shared/rpc-contract/worktree-create-params'

const PROVENANCE = {
  automationProvenance: undefined,
  cliProvenance: undefined,
  creatorProvenance: { kind: 'host' as const }
}

const build = (params: Record<string, unknown>) =>
  buildManagedWorktreeCreateArgs(WorktreeCreate.parse(params), PROVENANCE)

describe('buildManagedWorktreeCreateArgs', () => {
  it('carries one transient cwd-choice field through plain, startup and both modern launch schemas', () => {
    const choices = ['id:repo::/checkout', 'id:repo::/checkout::workspace:sibling']
    const create = {
      repo: 'id:repo',
      name: 'child',
      cwdParentWorktree: choices[0],
      cwdParentAmbiguous: true,
      callerTerminalHandle: 'term_R'
    }
    for (const schema of [AgentLaunch, AgentLaunchReplay]) {
      const request = schema.parse({
        agent: 'codex',
        operationId: '1760000000000-0123456789abcdef0123456789abcdef',
        target: { kind: 'create-worktree', create }
      })
      expect(request.target.kind).toBe('create-worktree')
      if (request.target.kind !== 'create-worktree') {
        throw new Error('wrong launch target')
      }
      expect(build(request.target.create).lineage).toMatchObject({
        cwdParentAmbiguous: true,
        cwdParentWorktree: choices[0],
        callerTerminalHandle: 'term_R'
      })
    }
    for (const payload of [create, { ...create, startupAgent: 'codex', startupPrompt: 'review' }]) {
      expect(build(payload).lineage).toMatchObject({
        cwdParentAmbiguous: true,
        cwdParentWorktree: choices[0],
        callerTerminalHandle: 'term_R'
      })
    }
    expect(
      build({ repo: 'id:repo', name: 'legacy', cwdParentWorktree: choices[0] }).lineage
    ).not.toHaveProperty('cwdParentAmbiguous')
  })
})
