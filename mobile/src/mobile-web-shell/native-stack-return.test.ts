import { describe, expect, it } from 'vitest'
import { nativeStackReturn, type NativeStackState } from './native-stack-return'

type Route = NativeStackState['routes'][number]

function stack(key: string, routes: readonly Route[]): NativeStackState {
  return {
    key,
    index: routes.length - 1,
    routes: routes.map((route, index) => ({ ...route, key: `${key}/${index}` }))
  }
}

function hostStack(...routes: Route[]): Route {
  return { name: 'h', state: stack('host-stack', routes) }
}

function rootStack(...routes: Route[]): NativeStackState {
  return stack('expo-root', [{ name: '__root', state: stack('root-stack', routes) }])
}

const HOME = { name: 'index' }
const HOST = { name: '[hostId]/index', params: { hostId: 'mac/1' } }
const SESSION = {
  name: '[hostId]/session/[worktreeId]',
  params: { hostId: 'mac/1', worktreeId: 'wt-a' }
}

describe('nativeStackReturn', () => {
  it('pops back to Home under the host instead of stacking a second Home', () => {
    expect(nativeStackReturn(rootStack(HOME, hostStack(HOST)), '/')).toEqual({
      target: 'root-stack',
      source: 'root-stack/1',
      count: 1
    })
  })

  it('finds nothing when the host is the root, as after a cold deep link', () => {
    expect(nativeStackReturn(rootStack(hostStack(HOST)), '/')).toBeNull()
  })

  it('returns to an exact path and query, however the href spells it', () => {
    const files = { name: '[hostId]/files/[worktreeId]', params: SESSION.params }
    const tabbed = { ...SESSION, params: { ...SESSION.params, tab: 'b', pane: '1' } }
    const state = rootStack(HOME, hostStack(HOST, tabbed, files))
    expect(nativeStackReturn(state, '/h/mac%2F1/session/wt-a?pane=1&tab=b')).toEqual({
      target: 'host-stack',
      source: 'host-stack/2',
      count: 1
    })
    expect(nativeStackReturn(state, '/h/mac%2F1')).toMatchObject({ target: 'host-stack', count: 2 })
    expect(nativeStackReturn(state, '/h/mac%2F1/session/wt-a?pane=1&tab=c')).toBeNull()
    expect(nativeStackReturn(state, '/h/mac%2F1/session/wt-b?pane=1&tab=b')).toBeNull()
  })

  it('treats a param cleared to empty as absent', () => {
    const cleared = { ...SESSION, params: { ...SESSION.params, paneKey: '' } }
    const state = rootStack(
      HOME,
      hostStack(HOST, cleared, { name: '[hostId]/files/[worktreeId]', params: SESSION.params })
    )
    expect(nativeStackReturn(state, '/h/mac%2F1/session/wt-a')).toMatchObject({ count: 1 })
  })

  it('names the focused screen as current rather than a pop', () => {
    const state = rootStack(HOME, hostStack(HOST, SESSION))
    expect(nativeStackReturn(state, '/h/mac%2F1/session/wt-a')).toBe('current')
  })
})
