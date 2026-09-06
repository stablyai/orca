import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MobileWebResumeRoute } from '../../../src/shared/mobile-web/bridge-contract'
import {
  useMobileWebResumeRouteMemory,
  type MobileWebResumeRouteMemory
} from './use-mobile-web-resume-route-memory'

const SESSION_ROUTE: MobileWebResumeRoute = {
  kind: 'session',
  workspaceId: 'repo::wt',
  workspaceName: 'Workspace one'
}

describe('useMobileWebResumeRouteMemory', () => {
  let renderer: ReactTestRenderer | null = null
  let memory: MobileWebResumeRouteMemory | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    renderer = null
    memory = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
  })

  function Harness(props: { hostId: string | undefined; shellSessionId: string | undefined }) {
    memory = useMobileWebResumeRouteMemory(props.hostId)
    // Why: a package swap mints a new shell session, so the harness re-renders like the shell does.
    void props.shellSessionId
    return null
  }

  function render(hostId: string | undefined, shellSessionId: string | undefined): void {
    act(() => {
      const element = createElement(Harness, { hostId, shellSessionId })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  it('starts at the workspace list', () => {
    render('host-1', undefined)
    expect(memory?.current()).toEqual({ kind: 'workspaceList' })
  })

  it('replays the remembered route after a package swap mints a new shell session', () => {
    render('host-1', 'session-1')
    act(() => memory?.remember(SESSION_ROUTE))

    render('host-1', 'session-2')

    expect(memory?.current()).toEqual(SESSION_ROUTE)
  })

  it('forgets a route belonging to another host', () => {
    render('host-1', 'session-1')
    act(() => memory?.remember(SESSION_ROUTE))

    render('host-2', 'session-2')

    expect(memory?.current()).toEqual({ kind: 'workspaceList' })
  })

  it('keeps the workspace list once the page navigates back to it', () => {
    render('host-1', 'session-1')
    act(() => memory?.remember(SESSION_ROUTE))
    act(() => memory?.remember({ kind: 'workspaceList' }))

    render('host-1', 'session-2')

    expect(memory?.current()).toEqual({ kind: 'workspaceList' })
  })
})
