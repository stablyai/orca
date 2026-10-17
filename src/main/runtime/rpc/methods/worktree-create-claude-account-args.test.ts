import { describe, expect, it } from 'vitest'
import { WorktreeCreate } from '../../../../shared/rpc-contract/worktree-create-params'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'

describe('worktree.create startupClaudeAccount', () => {
  it('requires a Claude startup agent', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'id:repo-1',
      startupAgent: 'codex',
      startupClaudeAccount: 'acct-b'
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      'startupClaudeAccount requires startupAgent claude'
    )
  })

  it('maps the selector to the runtime create only when present', () => {
    const pinned = WorktreeCreate.parse({
      repo: 'id:repo-1',
      startupAgent: 'claude',
      startupClaudeAccount: 'pinned@example.com'
    })
    expect(buildManagedWorktreeCreateArgs(pinned, {})).toMatchObject({
      startupAgent: 'claude',
      startupClaudeAccount: 'pinned@example.com'
    })
    const plain = WorktreeCreate.parse({ repo: 'id:repo-1', startupAgent: 'claude' })
    expect(buildManagedWorktreeCreateArgs(plain, {})).not.toHaveProperty('startupClaudeAccount')
  })
})
