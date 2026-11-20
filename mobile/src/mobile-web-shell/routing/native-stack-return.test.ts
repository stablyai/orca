import { describe, expect, it } from 'vitest'
import { nativeSessionReturn, type NativeStackState } from './native-stack-return'

const item = (itemId: string) => JSON.stringify({ sessionId: 'lead', itemId })
// The host stack with the session already open under its host list.
const state: NativeStackState = {
  key: 'root',
  routes: [
    {
      key: 'host',
      name: 'h/[hostId]',
      state: {
        key: 'host-stack',
        index: 1,
        routes: [
          { key: 'list', name: 'index', params: { hostId: 'desk' } },
          {
            key: 'chat',
            name: 'session/[worktreeId]',
            params: { hostId: 'desk', worktreeId: 'folder-1', paneKey: 'pane-1' }
          }
        ]
      }
    }
  ]
}
const request = (query: string) =>
  nativeSessionReturn(state, `/h/desk/session/folder-1?paneKey=pane-2${query}`)

describe('reusing an open session for a pane request', () => {
  it('carries the requested bot item to the session entry', () => {
    expect(request(`&botItem=${encodeURIComponent(item('q-1'))}`)).toMatchObject({
      routeKey: 'chat',
      params: { paneKey: 'pane-2', botItem: item('q-1') }
    })
  })

  it('explicitly clears the item when the pane request does not carry one', () => {
    expect(request('')?.params).toStrictEqual({
      paneKey: 'pane-2',
      botItem: undefined,
      paneIntent: expect.any(String)
    })
  })

  it('drops an item that is not a session item', () => {
    expect(request('&botItem=nope')?.params.botItem).toBe(undefined)
  })
  it('carries the request’s own intent to the session entry', () => {
    expect(request('&paneIntent=i-2')?.params.paneIntent).toBe('i-2')
  })

  it('names a page’s own pane request without an intent as a new one', () => {
    const first = request('')?.params.paneIntent
    expect(first).toBeTruthy()
    expect(request('')?.params.paneIntent).not.toBe(first)
  })
})
