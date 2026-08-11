import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../providers/types'
import { withSharedPtyProviderProcessSnapshot } from './pty-provider-process-snapshot'

describe('shared PTY provider process snapshots', () => {
  it('coalesces concurrent recovery after the first inventory fails', async () => {
    const rows = [{ id: 'pty-1', worktreeId: 'worktree-1', cwd: '/repo', title: 'shell' }]
    const listProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay unavailable'))
      .mockResolvedValueOnce(rows)
    const provider = withSharedPtyProviderProcessSnapshot({
      listProcesses
    } as unknown as IPtyProvider)

    await expect(
      Promise.all(Array.from({ length: 8 }, () => provider.listProcesses()))
    ).resolves.toEqual(Array.from({ length: 8 }, () => rows))
    expect(listProcesses).toHaveBeenCalledTimes(2)
  })
})
