import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'
import { UpdatePaneLayout } from '../../../../shared/rpc-contract/session-tabs-schemas-params'

const LAYOUT_PARAMS = {
  worktree: 'id:wt-1',
  tabId: 'tab-1',
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: 'leaf-a' },
    second: { type: 'leaf', leafId: 'leaf-b' },
    ratio: 0.3
  },
  expandedLeafId: null,
  chatLeafId: null,
  titlesByLeafId: { 'leaf-a': 'build' }
}

async function dispatchUpdatePaneLayout(params: Record<string, unknown>) {
  const updateMobileSessionPaneLayout = vi.fn().mockResolvedValue({ updated: true })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method only reaches updateMobileSessionPaneLayout when no clientKind is set.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    updateMobileSessionPaneLayout
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    { id: 'request-1', authToken: 'token', method: 'session.tabs.updatePaneLayout', params },
    (response) => replies.push(response),
    {}
  )
  const reply: unknown = JSON.parse(replies[0] ?? 'null')
  return { reply, runtimeCalls: updateMobileSessionPaneLayout.mock.calls }
}

describe('session.tabs.updatePaneLayout intent marker', () => {
  it.each([['gesture'], ['some-future-intent'], [42], [null]])(
    'treats a call carrying intent=%j exactly like one without it',
    async (intent) => {
      const unmarked = await dispatchUpdatePaneLayout(LAYOUT_PARAMS)
      const marked = await dispatchUpdatePaneLayout({ ...LAYOUT_PARAMS, intent })

      expect(unmarked.runtimeCalls).toHaveLength(1)
      expect(marked.runtimeCalls).toEqual(unmarked.runtimeCalls)
      expect(marked.reply).toEqual(unmarked.reply)
    }
  )

  it('parses an unmarked payload from an older client without adding the field', () => {
    expect(UpdatePaneLayout.parse(LAYOUT_PARAMS)).not.toHaveProperty('intent')
  })

  it('reads the gesture marker and degrades any other value to unmarked', () => {
    expect(UpdatePaneLayout.parse({ ...LAYOUT_PARAMS, intent: 'gesture' }).intent).toBe('gesture')
    for (const intent of ['some-future-intent', 42, null, { kind: 'gesture' }]) {
      expect(UpdatePaneLayout.parse({ ...LAYOUT_PARAMS, intent }).intent).toBeUndefined()
    }
  })
})
