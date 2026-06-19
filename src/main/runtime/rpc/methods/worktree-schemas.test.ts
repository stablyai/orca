import { describe, expect, it } from 'vitest'
import { WorktreeCreate } from './worktree-schemas'

describe('worktree RPC schemas', () => {
  it('rejects invalid startup agent values', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupAgent: 'wat',
      startupPrompt: 'hi'
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects startup prompts without startup agents', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupPrompt: 'hi'
    })

    expect(parsed.success).toBe(false)
  })
})
