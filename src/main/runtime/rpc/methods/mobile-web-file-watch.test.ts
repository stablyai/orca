import { afterEach, expect, it, vi } from 'vitest'
import { MOBILE_WEB_FILE_WATCH_METHOD } from './mobile-web-file-watch'
import { FILE_METHODS } from './files'
import { isStreamingMethod, type RpcContext } from '../core'

afterEach(() => vi.restoreAllMocks())

it('preserves stream lifecycle and future fields without publishing the workspace selector', async () => {
  const source = FILE_METHODS.find((method) => method.name === 'files.watch')!
  if (!isStreamingMethod(source)) {
    throw new Error('Expected file watch stream')
  }
  const events = [
    { type: 'ready', subscriptionId: 'opaque-stream' },
    { type: 'changed', worktree: 'id:private-workspace', events: [], future: { revision: 42 } },
    { type: 'end' }
  ]
  const handler = vi
    .spyOn(source, 'handler')
    .mockImplementation(async (_params, _context, emit) => {
      events.forEach(emit)
    })
  const context = { connectionId: 'connection', signal: new AbortController().signal } as RpcContext
  const params = { worktree: 'id:private-workspace' }
  const emit = vi.fn()
  await MOBILE_WEB_FILE_WATCH_METHOD.handler(params, context, emit)
  expect(handler).toHaveBeenCalledWith(params, context, expect.any(Function))
  expect(emit.mock.calls.map(([event]) => event)).toEqual([
    events[0],
    { type: 'changed', events: [], future: { revision: 42 } },
    events[2]
  ])
})
