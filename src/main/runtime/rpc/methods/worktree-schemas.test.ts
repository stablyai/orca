import { describe, expect, it } from 'vitest'
import { WorktreeCreate, WorktreeRemove } from './worktree-schemas'

describe('worktree RPC schemas', () => {
  it('accepts a positive hookTimeoutMs on worktree removal', () => {
    const parsed = WorktreeRemove.safeParse({
      worktree: 'active',
      runHooks: true,
      hookTimeoutMs: 300_000
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.hookTimeoutMs).toBe(300_000)
  })

  it('drops a non-positive hookTimeoutMs on worktree removal', () => {
    const parsed = WorktreeRemove.safeParse({ worktree: 'active', hookTimeoutMs: -5 })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.hookTimeoutMs).toBeUndefined()
  })

  it('accepts a positive hookTimeoutMs on worktree creation', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'feature',
      runHooks: true,
      hookTimeoutMs: 300_000
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.hookTimeoutMs).toBe(300_000)
  })

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
