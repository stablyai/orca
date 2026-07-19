import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { Store } from '../persistence'
import { createLocalHerdrPtyTargetResolver } from './herdr-project-pty-target'

describe('Herdr PTY target resolution', () => {
  it('routes the floating terminal through the reserved orca-global session', async () => {
    const store = {
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    } as unknown as Store
    const resolver = createLocalHerdrPtyTargetResolver(store)
    const leafId = '22222222-2222-4222-8222-222222222222'
    const target = await resolver(
      {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        tabId: 'floating-tab',
        paneKey: `floating-tab:${leafId}`
      },
      null
    )
    expect(target?.project.herdrSessionName).toBe('orca-global')
    expect(target?.identity).toMatchObject({
      projectId: 'orca-global',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      tabId: 'floating-tab',
      leafId
    })
  })
})
