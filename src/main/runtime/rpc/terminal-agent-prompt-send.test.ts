import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'

import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { TERMINAL_METHODS } from './methods/terminal'

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
    listWorktreesStrict: async () => [
      { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
    ]
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

function makeRequest(params: unknown): RpcRequest {
  return { id: 'request', authToken: 'token', method: 'terminal.send', params }
}

describe('terminal agent prompt send RPC', () => {
  it.each([false, true])(
    'refuses desktop input after late phone takeover (prompt=%s)',
    async (agentPrompt) => {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => {},
        'claude'
      )
      const selecting = Promise.withResolvers<void>()
      const release = Promise.withResolvers<boolean>()
      vi.spyOn(runtime, 'isTerminalRunningSettledPromptAgent').mockImplementation(() => {
        selecting.resolve()
        return release.promise
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const sending = dispatcher.dispatch(
        makeRequest({
          terminal: handle,
          text: 'first',
          enter: true,
          agentPrompt: true,
          client: { id: 'desktop-1', type: 'desktop' }
        }),
        { caller: { kind: 'paired-device', deviceId: 'desktop-pair' } }
      )
      await selecting.promise
      await runtime.handleMobileSubscribe('pty-prompt', 'phone-A', { cols: 45, rows: 20 })
      release.resolve(agentPrompt)
      await expect(sending).resolves.toMatchObject({
        ok: true,
        result: { send: { handle, accepted: false, bytesWritten: 0 } }
      })
      expect(writes).toEqual([])
    }
  )
})
