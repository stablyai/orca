import { describe, expect, it } from 'vitest'
import { nativeSessionReturn, type NativeStackState } from './native-stack-return'

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

describe('nativeSessionReturn', () => {
  const SOURCE_CONTROL = { name: '[hostId]/source-control/[worktreeId]', params: SESSION.params }

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
})
