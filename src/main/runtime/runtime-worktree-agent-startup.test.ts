import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  markCodexProjectTrusted: vi.fn(),
  markCopilotFolderTrusted: vi.fn(),
  markCursorWorkspaceTrusted: vi.fn()
}))

vi.mock('../agent-trust-presets', () => mocks)

import { markLocalWorktreeTrusted } from './runtime-worktree-agent-startup'

describe('markLocalWorktreeTrusted', () => {
  it('waits for the Codex trust write before resolving', async () => {
    let finish!: () => void
    mocks.markCodexProjectTrusted.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    let settled = false
    const marking = markLocalWorktreeTrusted('codex', '/workspace/app').then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await marking
    expect(mocks.markCodexProjectTrusted).toHaveBeenCalledWith('/workspace/app')
  })

  it('contains a rejected Codex trust write', async () => {
    mocks.markCodexProjectTrusted.mockRejectedValueOnce(new Error('write failed'))

    await expect(markLocalWorktreeTrusted('codex', '/workspace/app')).resolves.toBeUndefined()
  })
})
