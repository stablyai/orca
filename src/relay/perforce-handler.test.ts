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
        'deleteChangelistWithFiles',
        'deleteShelf',
        'detect',
        'diff',
        'diffText',
        'discard',
        'editDescription',
        'history',
        'info',
        'isReadOnlyFile',
        'moveToChangelist',
        'open',
        'shelve',
        'shelveAndRevertFiles',
        'status',
        'submit',
        'sync',
        'unshelve',
        'unshelveFiles',
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

  it('validates arguments of the shelf and changelist-delete operations', async () => {
    const handlers = register()
    await expect(
      handlers.get('perforce.shelveAndRevertFiles')?.({
        cwd: '/ws',
        changelist: 5,
        filePaths: ['../x']
      })
    ).rejects.toThrow('escapes')
    await expect(
      handlers.get('perforce.unshelveFiles')?.({
        cwd: '/ws',
        changelist: 5,
        depotPaths: ['src/main.py']
      })
    ).rejects.toThrow('depot path')
    await expect(
      handlers.get('perforce.deleteChangelistWithFiles')?.({ cwd: '/ws', changelist: 0 })
    ).rejects.toThrow('changelist number')
  })

  it('applies the caller-supplied Perforce settings to p4 calls', async () => {
    const result = await register().get('perforce.detect')?.({
      cwd: '/ws',
      settings: { p4Path: '/definitely/not/a/p4' }
    })
    expect(result).toMatchObject({ isWorkspace: false, reason: 'p4-not-found' })
  })
})
