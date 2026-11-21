import { expect, it } from 'vitest'
import { harness } from '../test-support/bridge-host-test-harness'
import { clientFrame } from '../test-support/bridge-host-test-fakes'
import { reportPageRouteRefusal } from '../routing/page-route-refusal'
import { readySession, run } from '../test-support/mobile-web-shell-session-test-fixtures'

const route = { pathname: '/h/host-a/session/workspace', params: { botItem: 'question-target' } }

it('refuses an exact-item route to an already mounted page without its consumer', () => {
  const bridge = harness({ route: { pathname: route.pathname } })
  bridge.host.receive(clientFrame({ type: 'ready' }))
  bridge.host.publishRoute(route)
  expect(bridge.routeRefusals).toContain('bot-item-links-unsupported')
  expect(bridge.frames().findLast((frame) => frame.type === 'init')).toMatchObject({
    route: { pathname: route.pathname }
  })
})

it('delivers the item to a consumer that advertised support, including a host rebuild', () => {
  const bridge = harness({ route })
  bridge.host.receive(clientFrame({ type: 'ready', botItemLinks: true }))
  expect(bridge.last()).toMatchObject({ type: 'init', route })
  const rebuilt = harness({
    route,
    sessionEstablished: true,
    sessionBack: bridge.host.readSessionBack()
  })
  rebuilt.host.publishRoute({ ...route, params: { botItem: 'next-question' } })
  expect(rebuilt.last()).toMatchObject({
    type: 'init',
    route: { params: { botItem: 'next-question' } }
  })
  expect(rebuilt.routeRefusals).toEqual([])
})

it('keeps the old document and held route while reporting an unsupported item as an update', () => {
  const previous = { pathname: route.pathname, params: { paneKey: 'existing-reader' } }
  let session = readySession().session
  let remounted = false
  let updates = false
  const cleared: string[] = []
  const bridge = harness({
    route: previous,
    onRouteRefused: (issue) =>
      reportPageRouteRefusal(issue, {
        route,
        clear: (param) => {
          cleared.push(param)
        },
        updateNeeded: () => {
          updates = true
        },
        documentFailed: () => {
          const reduced = run(session, { type: 'shell-failed', reason: 'document-load-failed' })
          session = reduced.session
          remounted = reduced.effects.some((effect) => effect.kind === 'remount')
        }
      })
  })
  bridge.host.receive(clientFrame({ type: 'ready' }))
  bridge.host.publishRoute(route)
  bridge.host.publishKeyboardInset(200)
  expect(bridge.last()).toMatchObject({ type: 'init', route: previous, keyboardInset: 200 })
  expect(session.state).toMatchObject({ kind: 'ready' })
  expect(remounted).toBe(false)
  expect(updates).toBe(true)
  expect(cleared).toEqual(['botItem'])
})
