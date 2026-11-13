import { RpcDispatcher } from '../../rpc/dispatcher'
import { TERMINAL_LIFECYCLE_METHODS } from '../../rpc/methods/terminal/terminal-lifecycle-methods'
import { describe, expect, it, vi } from 'vitest'
import {
  TAB_ID,
  WORKTREE_ID,
  setupMainOwnedWorkspace
} from '../../terminal/layout/main-owned-workspace-runtime-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const options = {
  reason: 'user' as const,
  requireStoppedTerminalTab: true,
  localPtyTeardownOwnedExternally: true
}

describe('close a stopped terminal tab by id', () => {
  it('removes the persisted stopped tab without a runtime handle', async () => {
    const f = setupMainOwnedWorkspace({ stopped: true })
    const listed = await f.runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect([...listed.terminals, ...(listed.tabs ?? [])].map((tab) => tab.tabId)).toContain('tab-1')
    await f.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, options)
    expect(f.session().tabsByWorktree['repo-1::/workspace']).toEqual([])
    expect(f.stopped).toEqual([])
  })

  it.each([
    ['missing', 'terminal_tab_not_found'],
    ['live', 'terminal_tab_live'],
    ['unknown', 'terminal_stop_unverifiable']
  ])('preserves the %s refusal across RPC', async (state, code) => {
    const f = setupMainOwnedWorkspace({ stopped: state !== 'live' })
    if (state === 'unknown') {
      f.session().remoteSessionIdsByTabId = { [TAB_ID]: 'unverified-saved-pty' }
    }
    const dispatcher = new RpcDispatcher({
      runtime: f.runtime,
      methods: TERMINAL_LIFECYCLE_METHODS
    })
    const reply = await dispatcher.dispatch({
      id: 'close-stopped',
      authToken: 'unused',
      method: 'terminal.closeTabById',
      params: { worktree: `id:${WORKTREE_ID}`, tabId: state === 'missing' ? 'absent' : TAB_ID }
    })
    expect(reply).toMatchObject({ ok: false, error: { code } })
    if (state === 'live') {
      expect(reply).toMatchObject({
        error: { data: { nextStep: 'Use orca terminal close --terminal <handle> --tab.' } }
      })
    }
    expect(f.session().tabsByWorktree['repo-1::/workspace']?.map((tab) => tab.id)).toEqual([
      'tab-1'
    ])
    expect(f.stopped).toEqual([])
  })
})
