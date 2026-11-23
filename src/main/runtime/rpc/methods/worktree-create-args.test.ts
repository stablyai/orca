import { describe, expect, it } from 'vitest'
import { buildManagedWorktreeCreateArgs } from './workspaces/worktree-create-args'
import { WorktreeCreate } from '../../../../shared/rpc-contract/workspaces/worktree-create-params'

const PROVENANCE = {
  automationProvenance: undefined,
  cliProvenance: undefined,
  creatorProvenance: { kind: 'host' as const }
}

describe('buildManagedWorktreeCreateArgs', () => {
  it("drops a paired client's session claim, which names a session on another host", () => {
    const params = WorktreeCreate.parse({
      repo: 'id:repo-1',
      name: 'child',
      callerAgentSessionId: 'session-1'
    })
    expect(buildManagedWorktreeCreateArgs(params, PROVENANCE, {}).lineage).toMatchObject({
      callerAgentSessionId: 'session-1'
    })
    expect(
      buildManagedWorktreeCreateArgs(params, PROVENANCE, { pairedDeviceId: 'phone-1' }).lineage
    ).not.toHaveProperty('callerAgentSessionId')
  })
})
