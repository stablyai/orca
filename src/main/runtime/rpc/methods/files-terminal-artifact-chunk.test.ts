import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { FILE_METHODS } from './files'

describe('terminal artifact chunk RPC', () => {
  it('forwards the bounded chunk request and client identity', async () => {
    const readTerminalArtifactChunk = vi.fn().mockResolvedValue({
      contentBase64: 'YWJj',
      bytesRead: 3,
      eof: false
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readTerminalArtifactChunk
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'files.readTerminalArtifactChunk',
      params: {
        worktree: 'id:wt-1',
        grantId: 'grant-1',
        absolutePath: '/tmp/result.bin',
        offset: 4,
        length: 3,
        maxBytes: 64
      }
    }

    const reply = vi.fn()
    await dispatcher.dispatchStreaming(request, reply, { clientId: 'client-a' })

    expect(readTerminalArtifactChunk).toHaveBeenCalledWith(
      'id:wt-1',
      'grant-1',
      '/tmp/result.bin',
      4,
      3,
      64,
      'client-a'
    )
    expect(JSON.parse(reply.mock.calls[0][0])).toMatchObject({
      ok: true,
      result: { bytesRead: 3 }
    })
  })
})
