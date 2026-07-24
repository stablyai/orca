import { describe, expect, it, vi } from 'vitest'
import { RelayContext } from './context'
import { RelayDispatcher, type RequestContext } from './dispatcher'
import { GitHandler } from './git-handler'
import { GIT_RESPONSE_STREAM_THRESHOLD, type GitResponseStreamMarker } from './protocol'

type StreamableGitHandler = {
  maybeStreamResponse(
    result: unknown,
    params: Record<string, unknown>,
    context: RequestContext
  ): GitResponseStreamMarker
}

describe('GitHandler streamed response serialization', () => {
  it('registers a large serialized string without allocating a full payload Buffer', () => {
    const dispatcher = new RelayDispatcher(() => true)
    const handler = new GitHandler(dispatcher, new RelayContext())
    const streamable = handler as unknown as StreamableGitHandler
    const result = { text: 'x'.repeat(GIT_RESPONSE_STREAM_THRESHOLD + 1) }
    const fromSpy = vi.spyOn(Buffer, 'from')

    try {
      const marker = streamable.maybeStreamResponse(
        result,
        { __streamResponse: true },
        { clientId: 1, isStale: () => false }
      )

      expect(marker.__orcaGitResponseStream.totalBytes).toBe(
        Buffer.byteLength(JSON.stringify(result), 'utf8')
      )
      expect(fromSpy).not.toHaveBeenCalled()
    } finally {
      handler.dispose()
      dispatcher.dispose()
      fromSpy.mockRestore()
    }
  })
})
