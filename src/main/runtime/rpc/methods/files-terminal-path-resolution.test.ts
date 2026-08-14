import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('files.resolveTerminalPath RPC', () => {
  function createDispatcher() {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveTerminalPath: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        relativePath: 'src/index.ts',
        exists: true,
        isDirectory: false
      })
    } as unknown as OrcaRuntimeService
    return { runtime, dispatcher: new RpcDispatcher({ runtime, methods: FILE_METHODS }) }
  }

  it('resolves a tapped terminal path for a selected worktree', async () => {
    const { runtime, dispatcher } = createDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('files.resolveTerminalPath', {
        worktree: 'id:wt-1',
        pathText: '/repo/src/index.ts',
        cwd: '/repo',
        terminal: 'term-1'
      })
    )

    expect(runtime.resolveTerminalPath).toHaveBeenCalledWith(
      'id:wt-1',
      '/repo/src/index.ts',
      '/repo',
      undefined,
      'term-1',
      false,
      null
    )
    expect(response).toMatchObject({
      ok: true,
      result: { relativePath: 'src/index.ts', exists: true, isDirectory: false }
    })
  })

  // Why: clients predating crossWorkspace reuse their own worktree id for the
  // follow-up files.open, so sibling-workspace retargeting must be an explicit opt-in.
  it('forwards crossWorkspace only when the client opts in', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest('files.resolveTerminalPath', {
        worktree: 'id:wt-1',
        pathText: '/sibling/docs/readme.md',
        crossWorkspace: true
      })
    )

    expect(runtime.resolveTerminalPath).toHaveBeenLastCalledWith(
      'id:wt-1',
      '/sibling/docs/readme.md',
      null,
      undefined,
      null,
      true,
      null
    )
  })

  it('forwards optional native-chat provenance', async () => {
    const { runtime, dispatcher } = createDispatcher()

    await dispatcher.dispatch(
      makeRequest('files.resolveTerminalPath', {
        worktree: 'id:wt-1',
        pathText: '/outside/result.html',
        nativeChatContext: { tabId: 'tab-1', sessionId: 'session-1' }
      })
    )

    expect(runtime.resolveTerminalPath).toHaveBeenLastCalledWith(
      'id:wt-1',
      '/outside/result.html',
      null,
      undefined,
      null,
      false,
      { tabId: 'tab-1', sessionId: 'session-1' }
    )
  })
})
