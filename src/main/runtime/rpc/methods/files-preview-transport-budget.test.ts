import { describe, expect, it, vi } from 'vitest'
import { remoteRpcContentBudget } from '../../../../shared/remote-rpc-content-budget'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('file preview RPC transport budgets', () => {
  it.each(['mobile', 'runtime'] as const)(
    'charges the %s request id to both preview content budgets',
    async (clientKind) => {
      const preview = {
        content: 'base64',
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      }
      const readFileExplorerPreview = vi.fn().mockResolvedValue(preview)
      const readTerminalArtifactPreview = vi.fn().mockResolvedValue(preview)
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        readFileExplorerPreview,
        readTerminalArtifactPreview
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
      const id = '\u0001'.repeat(8_192)
      const reply = vi.fn()

      await dispatcher.dispatchStreaming(
        {
          ...makeRequest('files.readPreview', { worktree: 'id:wt-1', relativePath: 'logo.png' }),
          id
        },
        reply,
        { clientKind }
      )
      await dispatcher.dispatchStreaming(
        {
          ...makeRequest('files.readTerminalArtifactPreview', {
            worktree: 'id:wt-1',
            absolutePath: '/tmp/logo.png',
            grantId: 'grant-1'
          }),
          id
        },
        reply,
        { clientKind }
      )

      const budget = remoteRpcContentBudget(id)
      expect(readFileExplorerPreview).toHaveBeenCalledWith('id:wt-1', 'logo.png', budget)
      expect(readTerminalArtifactPreview).toHaveBeenCalledWith(
        'id:wt-1',
        'grant-1',
        '/tmp/logo.png',
        undefined,
        budget
      )
    }
  )
})
