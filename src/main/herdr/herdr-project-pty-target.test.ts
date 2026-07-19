import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { Store } from '../persistence'
import { createLocalHerdrPtyTargetResolver } from './herdr-project-pty-target'

const leafId = '22222222-2222-4222-8222-222222222222'

function floatingSpawnOptions() {
  return {
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    tabId: 'floating-tab',
    paneKey: `floating-tab:${leafId}`
  }
}

describe('Herdr PTY target resolution', () => {
  it('leaves floating terminals on Orca when Herdr is not selected', async () => {
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'orca' }),
      getProjects: () => [],
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    } as unknown as Store

    const target = await createLocalHerdrPtyTargetResolver(store)(floatingSpawnOptions(), null)

    expect(target).toBeNull()
  })

  it('routes floating terminals through the reserved session when Herdr is selected', async () => {
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'herdr' }),
      getProjects: () => [],
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    } as unknown as Store

    const target = await createLocalHerdrPtyTargetResolver(store)(floatingSpawnOptions(), null)

    expect(target?.project.herdrSessionName).toBe('orca-global')
    expect(target?.identity).toMatchObject({
      projectId: 'orca-global',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      tabId: 'floating-tab',
      leafId
    })
  })
})
