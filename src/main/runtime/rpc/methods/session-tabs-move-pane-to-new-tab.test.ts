import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'

async function dispatchMove(result: unknown) {
  const moveMobileSessionLeafToNewTab = vi.fn().mockResolvedValue(result)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method only reaches moveMobileSessionLeafToNewTab.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    moveMobileSessionLeafToNewTab
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'request-1',
      authToken: 'token',
      method: 'session.tabs.movePaneToNewTab',
      params: { worktree: 'id:wt-1', sourceTabId: 'tab-1', targetTabId: 'tab-2', leafId: 'leaf-b' }
    },
    (response) => replies.push(response),
    {}
  )
  return {
    reply: JSON.parse(replies[0] ?? 'null'),
    calls: moveMobileSessionLeafToNewTab.mock.calls
  }
}
describe('session.tabs.movePaneToNewTab', () => {
  it('hands host tab ids to the runtime and returns its move result', async () => {
    const { reply, calls } = await dispatchMove({ status: 'moved', ptyId: 'pty-1' })
    expect(calls[0].slice(0, 2)).toEqual([
      'id:wt-1',
      { sourceTabId: 'tab-1', targetTabId: 'tab-2', leafId: 'leaf-b' }
    ])
    expect(reply).toMatchObject({ ok: true, result: { status: 'moved', ptyId: 'pty-1' } })
  })
})
