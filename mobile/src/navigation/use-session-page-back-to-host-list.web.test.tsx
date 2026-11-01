import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostStackNavigationState } from './host-stack-navigation'

const SESSION = '[hostId]/session/[worktreeId]'

const page = vi.hoisted(() => ({
  hostId: 'host-1',
  shellPath: null as string | null,
  client: true,
  canGoBack: false,
  back: vi.fn(),
  replace: vi.fn(),
  claim: null as (() => boolean) | null,
  dispatch: vi.fn(),
  state: undefined as HostStackNavigationState | undefined
}))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ hostId: page.hostId }),
  useRouter: () => ({
    canGoBack: () => page.canGoBack,
    back: page.back,
    replace: page.replace
  }),
  useNavigation: () => ({
    getState: () => page.state,
    addListener: () => () => {},
    dispatch: page.dispatch
  })
}))

vi.mock('../transport/client-context.web', () => ({
  usePageBridgeClientIfPresent: () =>
    page.client
      ? {
          getShellSession: () =>
            page.shellPath === null ? null : { route: { pathname: page.shellPath } },
          claimBack: (handler: () => boolean) => {
            page.claim = handler
            return () => {
              page.claim = null
            }
          }
        }
      : null
}))

import { useSessionPageBackToHostList } from './use-session-page-back-to-host-list.web'

function Probe() {
  useSessionPageBackToHostList()
  return null
}

let renderer: ReactTestRenderer | null = null

function sessionState(): HostStackNavigationState {
  return {
    key: 'page-stack',
    index: 0,
    routes: [{ key: 'session', name: SESSION, params: { hostId: 'host-1', worktreeId: 'wt' } }]
  }
}

beforeEach(() => {
  page.hostId = 'host-1'
  page.shellPath = null
  page.client = true
  page.canGoBack = false
  page.claim = null
  page.state = sessionState()
  page.back.mockClear()
  page.replace.mockClear()
  page.dispatch.mockClear()
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function renderPage() {
  act(() => {
    renderer = create(createElement(Probe))
  })
}

describe('session page back to the host list', () => {
  it('leaves a shell-opened session document to the native stack', () => {
    page.shellPath = '/h/host-1/session/wt'
    renderPage()

    expect(page.dispatch).not.toHaveBeenCalled()
    expect(page.claim).toBeNull()
  })

  it('inserts the host list inside a host document and claims Back', () => {
    page.shellPath = '/h/host-1'
    renderPage()

    expect(page.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RESET',
        target: 'page-stack',
        payload: expect.objectContaining({
          index: 1,
          routes: [
            expect.objectContaining({ key: 'host-session-list:host-1', name: '[hostId]/index' }),
            expect.objectContaining({ key: 'session' })
          ]
        })
      })
    )
    expect(page.claim).toEqual(expect.any(Function))

    page.claim?.()
    expect(page.replace).toHaveBeenCalledWith('/h/host-1')
    expect(page.back).not.toHaveBeenCalled()

    page.canGoBack = true
    page.claim?.()
    expect(page.back).toHaveBeenCalledTimes(1)
  })

  it('repairs a standalone page that has no shell client, without claiming Back', () => {
    page.client = false
    renderPage()

    expect(page.dispatch).toHaveBeenCalledTimes(1)
    expect(page.claim).toBeNull()
  })

  it('does nothing when the session has no host id', () => {
    page.hostId = ''
    page.shellPath = '/h/host-1'
    renderPage()

    expect(page.dispatch).not.toHaveBeenCalled()
    expect(page.claim).toBeNull()
  })
})
