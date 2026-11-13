import { describe, expect, it } from 'vitest'
import {
  nativeSessionReturn,
  nativeStackReturn,
  type NativeStackState
} from './native-stack-return'

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

describe('nativeSessionReturn', () => {
  const SOURCE_CONTROL = { name: '[hostId]/source-control/[worktreeId]', params: SESSION.params }
  const spent = { ...SESSION, params: { ...SESSION.params, paneKey: '', name: 'Workspace A' } }
  const href = '/h/mac%2F1/session/wt-a?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111'

  it('finds the session beneath source control whatever pane or name its entry carries', () => {
    const state = rootStack(HOME, hostStack(HOST, spent, SOURCE_CONTROL))
    expect(nativeSessionReturn(state, href)).toEqual({
      target: 'host-stack',
      source: 'host-stack/2',
      count: 1,
      routeKey: 'host-stack/1'
    })
  })

  it('names the focused session with nothing to pop', () => {
    const state = rootStack(HOME, hostStack(HOST, spent))
    expect(nativeSessionReturn(state, href)).toEqual({
      target: 'host-stack',
      source: 'host-stack/1',
      count: 0,
      routeKey: 'host-stack/1'
    })
  })

  it('finds nothing when only another workspace or execution host is on the stack', () => {
    const other = { ...SESSION, params: { hostId: 'mac/1', worktreeId: 'wt-b' } }
    expect(
      nativeSessionReturn(rootStack(HOME, hostStack(HOST, other, SOURCE_CONTROL)), href)
    ).toBeNull()
    const remote = { ...SESSION, params: { ...SESSION.params, executionHost: 'ssh:box' } }
    expect(
      nativeSessionReturn(rootStack(HOME, hostStack(HOST, remote, SOURCE_CONTROL)), href)
    ).toBeNull()
    expect(
      nativeSessionReturn(
        rootStack(HOME, hostStack(HOST, remote, SOURCE_CONTROL)),
        `${href}&executionHost=ssh%3Abox`
      )
    ).toMatchObject({ count: 1, routeKey: 'host-stack/1' })
  })

  it('keeps worktrees apart when they differ only after an encoded question mark', () => {
    const onStack = { ...SESSION, params: { hostId: 'mac/1', worktreeId: 'repo::/w/a?x' } }
    const state = rootStack(HOME, hostStack(HOST, onStack, SOURCE_CONTROL))
    const to = (worktreeId: string) =>
      `/h/mac%2F1/session/${encodeURIComponent(worktreeId)}?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111`
    expect(nativeSessionReturn(state, to('repo::/w/a?y'))).toBeNull()
    expect(nativeSessionReturn(state, to('repo::/w/a'))).toBeNull()
    expect(nativeSessionReturn(state, to('repo::/w/a?x'))).toMatchObject({
      count: 1,
      routeKey: 'host-stack/1'
    })
  })

  it('keeps execution hosts apart for a worktree holding an encoded question mark', () => {
    const params = { hostId: 'mac/1', worktreeId: 'repo::/w/a?x' }
    const local = `/h/mac%2F1/session/${encodeURIComponent(params.worktreeId)}?paneKey=tab-1%3A11111111-1111-4111-8111-111111111111`
    const remote = { ...SESSION, params: { ...params, executionHost: 'ssh:box' } }
    const state = rootStack(HOME, hostStack(HOST, remote, SOURCE_CONTROL))
    expect(nativeSessionReturn(state, local)).toBeNull()
    expect(nativeSessionReturn(state, `${local}&executionHost=ssh%3Aother`)).toBeNull()
    expect(nativeSessionReturn(state, `${local}&executionHost=ssh%3Abox`)).toMatchObject({
      count: 1,
      routeKey: 'host-stack/1'
    })
  })

  it('answers only session hrefs', () => {
    const state = rootStack(HOME, hostStack(HOST, spent, SOURCE_CONTROL))
    expect(nativeSessionReturn(state, '/h/mac%2F1/source-control/wt-a?paneKey=x')).toBeNull()
  })
})
