import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { abortWhenOwnerDocumentEnds, type AvatarRunOwner } from './avatar-run-owner-lifetime'

function start(destroyed = false) {
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed })
  const controller = new AbortController()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper only subscribes with once/on/removeListener, which EventEmitter provides.
  const release = abortWhenOwnerDocumentEnds(owner as unknown as AvatarRunOwner, controller)
  return { owner, controller, release }
}

it('aborts the run when its document commits a navigation', () => {
  const { owner, controller } = start()

  owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(controller.signal.aborted).toBe(false)

  owner.emit('did-navigate')
  expect(controller.signal.aborted).toBe(true)
})

it('aborts the run when its renderer is lost', () => {
  const { owner, controller } = start()

  owner.emit('render-process-gone')

  expect(controller.signal.aborted).toBe(true)
})

it('stops listening once the run is released', () => {
  const { owner, controller, release } = start()

  release()
  owner.emit('destroyed')

  expect(controller.signal.aborted).toBe(false)
  expect(owner.listenerCount('did-navigate')).toBe(0)
})

it('aborts at once when the document is already gone', () => {
  const { controller } = start(true)

  expect(controller.signal.aborted).toBe(true)
})
