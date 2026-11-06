import { describe, expect, it, vi } from 'vitest'
import {
  hostSessionListHref,
  returnToHostSessionList,
  sessionListBackTarget
} from './session-list-back'

const DEEP = [
  '/h/host-1/session/wt-1',
  '/h/host-1/session/wt-1?pane=child',
  '/h/host-1/tasks',
  '/h/host-1/session/folder%3Anotes',
  '/h/mac%2F1/source-control/wt-9',
  '/h/host-1/automations/run/42'
] as const

describe('session list long-press target', () => {
  it('resolves a long-press from deep routes to the host session list', () => {
    for (const pathname of DEEP) {
      const hostId = pathname.startsWith('/h/mac%2F1') ? 'mac/1' : 'host-1'
      expect(
        sessionListBackTarget({
          gesture: 'longPress',
          hostId,
          pathname,
          oneStepHref: '/h/host-1/session/wt-1'
        })
      ).toBe(hostSessionListHref(hostId))
    }
    expect(hostSessionListHref('mac/1')).toBe('/h/mac%2F1')
  })

  it('leaves a tap on its one-step target', () => {
    for (const pathname of DEEP) {
      const oneStepHref = `${pathname}#step`
      expect(
        sessionListBackTarget({
          gesture: 'tap',
          hostId: 'host-1',
          pathname,
          oneStepHref
        })
      ).toBe(oneStepHref)
    }
  })

  it('does not navigate when there is no host or the list is already showing', () => {
    expect(
      sessionListBackTarget({
        gesture: 'longPress',
        hostId: null,
        pathname: '/pair-scan',
        oneStepHref: '/'
      })
    ).toBeNull()
    expect(
      sessionListBackTarget({
        gesture: 'longPress',
        hostId: 'mac/1',
        pathname: '/h/mac%2F1',
        oneStepHref: '/'
      })
    ).toBeNull()
    expect(
      sessionListBackTarget({
        gesture: 'tap',
        hostId: null,
        pathname: '/pair-scan',
        oneStepHref: '/'
      })
    ).toBe('/')
  })

  it('asks the same dismissTo host exit the shell uses', () => {
    const dismissTo = vi.fn()
    returnToHostSessionList({ dismissTo }, 'mac/1')
    expect(dismissTo).toHaveBeenCalledExactlyOnceWith('/h/mac%2F1')
  })
})
