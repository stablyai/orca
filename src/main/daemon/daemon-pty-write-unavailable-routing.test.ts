import { expect, it } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import { createAdapter, identity } from './daemon-pty-router-routing-safety-fixture'

it('forwards write-unavailable signals from each exact routed owner', () => {
  const current = createAdapter('current')
  const legacy = createAdapter('legacy')
  const router = new DaemonPtyRouter({
    current: current.adapter,
    legacy: [legacy.adapter]
  })
  const recovered: string[] = []
  current.emitData('current-pane', 'route evidence')
  legacy.emitData('legacy-pane', 'route evidence')
  const unsubscribe = router.onWriteUnavailable(({ id }) => recovered.push(id))

  current.emitWriteUnavailable('current-pane')
  legacy.emitWriteUnavailable('legacy-pane')

  expect(recovered).toEqual(['current-pane', 'legacy-pane'])
  unsubscribe()
  current.emitWriteUnavailable('current-pane')
  expect(recovered).toEqual(['current-pane', 'legacy-pane'])
})

it('withholds write-unavailable signals from foreign and stale adapter routes', () => {
  const current = createAdapter('current')
  const legacy = createAdapter('legacy')
  const router = new DaemonPtyRouter({
    current: current.adapter,
    legacy: [legacy.adapter]
  })
  const recovered: string[] = []
  const previous = identity('current', 20)
  const replacement = identity('current', 21)
  current.emitData('shared-pane', 'route evidence')
  router.onWriteUnavailable(({ id }) => recovered.push(id))

  legacy.emitWriteUnavailable('shared-pane')
  current.emitWriteUnavailable('shared-pane')
  current.emitData('ambiguous-pane', 'current collision evidence')
  legacy.emitData('ambiguous-pane', 'legacy collision evidence')
  current.emitWriteUnavailable('ambiguous-pane')
  legacy.emitWriteUnavailable('ambiguous-pane')
  current.setIdentity(replacement)
  current.emitIdentityChange(previous, replacement)
  current.emitWriteUnavailable('shared-pane')

  expect(recovered).toEqual(['shared-pane'])
})
