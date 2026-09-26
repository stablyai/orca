import { describe, expect, it } from 'vitest'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { PerforceHandler } from './perforce-handler'

type Handler = (params: Record<string, unknown>) => Promise<unknown>

const CONTEXT: RequestContext = { clientId: 1, isStale: () => false }

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const dispatcher: Pick<RelayDispatcher, 'onRequest'> = {
    onRequest: (method, handler) => {
      handlers.set(method, async (params) => handler(params, CONTEXT))
    }
  }
  new PerforceHandler(dispatcher)
  return handlers
}

describe('PerforceHandler', () => {
  it('registers the full perforce.* surface', () => {
    expect([...register().keys()].sort()).toEqual(
      [
        'checkoutIfReadOnly',
        'close',
        'createChangelist',
        'deleteChangelist',
        'deleteShelf',
        'detect',
        'diff',
        'discard',
        'editDescription',
        'history',
        'moveToChangelist',
        'open',
        'shelve',
        'status',
        'submit',
        'sync',
        'unshelve',
        'unshelveFrom'
      ].map((name) => `perforce.${name}`)
    )
  })

  it('rejects relative workspace paths and escaping file paths before running p4', async () => {
    const handlers = register()
    await expect(handlers.get('perforce.status')?.({ cwd: 'relative/dir' })).rejects.toThrow(
      'absolute'
    )
    await expect(
      handlers.get('perforce.open')?.({ cwd: '/ws', filePaths: ['../../etc/passwd'] })
    ).rejects.toThrow('escapes')
    await expect(
      handlers.get('perforce.submit')?.({ cwd: '/ws', changelist: 'default', message: '  ' })
    ).rejects.toThrow('required')
  })
})
