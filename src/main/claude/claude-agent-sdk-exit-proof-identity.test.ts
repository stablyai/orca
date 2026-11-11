import { describe, expect, it, vi } from 'vitest'

import { collectDescendantRows } from '../pty/process-retirement/pty-descendant-termination'
import { createClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

describe('Claude child root identity', () => {
  it('rejects mixed old and recycled root rows instead of making the tree killable', async () => {
    const child = { pid: 100, kill: vi.fn(() => true) }
    const terminateDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(child, {
      site: 'claude-structured-child-close',
      platform: 'linux',
      captureDescendants: vi.fn(async () =>
        collectDescendantRows(
          100,
          [
            { pid: 100, ppid: 1, pgid: 100, startedAt: 'Mon Jan 1 00:00:00 2026' },
            { pid: 100, ppid: 1, pgid: 101, startedAt: 'Mon Jan 1 00:00:01 2026' },
            { pid: 200, ppid: 100, pgid: 200, startedAt: 'Mon Jan 1 00:00:00 2026' }
          ],
          1
        )
      ),
      terminateDescendants
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(terminateDescendants).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
