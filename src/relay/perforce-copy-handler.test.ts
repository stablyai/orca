import { describe, expect, it } from 'vitest'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { PerforceCopyHandler } from './perforce-copy-handler'

type Handler = (params: Record<string, unknown>) => Promise<unknown>

const CONTEXT: RequestContext = { clientId: 1, isStale: () => false }

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const dispatcher: Pick<RelayDispatcher, 'onRequest'> = {
    onRequest: (method, handler) => {
      handlers.set(method, async (params) => handler(params, CONTEXT))
    }
  }
  new PerforceCopyHandler(dispatcher)
  return handlers
}

describe('PerforceCopyHandler', () => {
  it('registers the perforce copy methods', () => {
    expect([...register().keys()].sort()).toEqual([
      'perforce.copyReadiness',
      'perforce.createCopy',
      'perforce.listCopies',
      'perforce.listCopyStreams',
      'perforce.previewCopyRemoval',
      'perforce.removeCopy'
    ])
  })

  it('rejects a relative workspace path and an invalid copy name before running p4', async () => {
    const handlers = register()
    await expect(handlers.get('perforce.listCopies')?.({ cwd: 'relative/ws' })).rejects.toThrow(
      /absolute/
    )
    await expect(
      handlers.get('perforce.removeCopy')?.({ cwd: process.cwd(), name: '../escape' })
    ).rejects.toThrow(/1-24 letters/)
    await expect(
      handlers.get('perforce.createCopy')?.({
        cwd: process.cwd(),
        options: { name: 'ok', stream: { kind: 'stream', stream: 'not-a-depot-path' } }
      })
    ).rejects.toThrow(/stream choice/)
  })
})
