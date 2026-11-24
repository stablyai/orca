import { expect, it, vi } from 'vitest'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime/workspaces/creation/runtime-managed-worktree-create-types'
import { createWorktreeWithStartupAgent } from './startup-agent-worktree-create'

it('refuses a legacy startup draft whose create outlives its approval', async () => {
  let approved = true
  // The create asks again once the worktree exists, right before it starts the terminal.
  const createManagedWorktree = vi.fn(async (args: RuntimeManagedWorktreeCreateArgs) => {
    approved = false
    await Promise.resolve()
    args.beforeEffect?.()
    return { worktree: { id: 'wt-1' } }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a passthrough create reaches only `createManagedWorktree`.
  const runtime = {
    createManagedWorktree
  } as unknown as Parameters<typeof createWorktreeWithStartupAgent>[0]

  await expect(
    createWorktreeWithStartupAgent(
      runtime,
      {
        repoSelector: 'id:repo-1',
        name: 'review',
        startup: { command: 'claude' },
        startupDraftPaste: { agent: 'claude', content: 'Summarize the change.' }
      },
      {
        beforeEffect: () => {
          if (!approved) {
            throw new Error('plugin_approval_revoked')
          }
        }
      }
    )
  ).rejects.toThrow('plugin_approval_revoked')
})
