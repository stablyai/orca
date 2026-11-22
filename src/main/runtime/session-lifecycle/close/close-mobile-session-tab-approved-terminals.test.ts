import { describe, expect, it } from 'vitest'
import {
  setupMainOwnedWorkspace,
  LEAF_A,
  PTY_A,
  TAB_ID,
  WORKTREE_ID
} from '../../terminal/layout/main-owned-workspace-runtime-fixture'

const NEW_LEAF = '33333333-3333-4333-8333-333333333333'

async function setup() {
  const fixture = await setupMainOwnedWorkspace()
  const stopped: string[] = []
  fixture.runtime.setPtyController({
    write: () => true,
    kill: (ptyId: string) => stopped.push(ptyId) > 0,
    stopAndWait: async (ptyId: string) => stopped.push(ptyId) > 0,
    getForegroundProcess: async () => null
  })
  const approved = [fixture.handleOf(PTY_A)]
  return { fixture, stopped, approved }
}

describe('closing a tab for approved terminals', () => {
  it('refuses and stops nothing when a terminal arrived after the approval', async () => {
    const { fixture, stopped, approved } = await setup()
    await fixture.runtime.applyLayoutCommand({
      type: 'splitPane',
      workspace: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_A,
      direction: 'vertical',
      newLeafId: NEW_LEAF
    })
    fixture.runtime.registerPty('pty-new', WORKTREE_ID, null, { tabId: TAB_ID, leafId: NEW_LEAF })
    fixture.bindPaneTerminal(NEW_LEAF, 'pty-new')

    const result = await fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, {
      reason: 'user',
      approvedTerminalHandles: approved
    })

    expect(result).toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
    expect(stopped).toEqual([])
  })

  it('stops the approved terminal when nothing changed', async () => {
    const { fixture, stopped, approved } = await setup()

    const result = await fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, {
      reason: 'user',
      approvedTerminalHandles: approved
    })

    expect(result.refused).toBeUndefined()
    expect(stopped).toEqual([PTY_A])
  })
})
