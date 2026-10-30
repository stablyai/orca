import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mailTestResources } from './mail-handoff.test-fixture'
import { OrchestrationDb } from './db'
import { captureSessionMailAtStop } from './session-mail-stop-inventory'

const resources = mailTestResources('pr28567-global-cut-')
it('captures a global cut under its exact zero-wait reservation; busy/reentrant capture never releases another writer', () => {
  const path = join(resources.directory(), 'mail.db')
  const db = resources.track(new OrchestrationDb(path))
  const peer = resources.track(new OrchestrationDb(path))
  peer.db.pragma('busy_timeout = 0')
  peer.db.exec('BEGIN IMMEDIATE')
  expect(captureSessionMailAtStop(db, vi.fn())).toEqual({})
  expect(peer.db.isTransaction).toBe(true)
  peer.db.exec('ROLLBACK')
  const message = db.insertMessage({ from: 'worker', to: 'unrelated', subject: 'cut' })
  const captured = captureSessionMailAtStop(db, vi.fn())
  expect(captured.cut?.throughSequence).toBe(message.sequence)
  expect(captureSessionMailAtStop(db, vi.fn())).toEqual({})
  expect(db.db.isTransaction).toBe(true)
  expect(() => peer.insertMessage({ from: 'peer', to: 'any', subject: 'racing' })).toThrow()
  captured.finished?.()
  expect(db.db.isTransaction).toBe(false)
  expect(db.db.pragma('busy_timeout', { simple: true })).toBe(5000)
  expect(
    peer.insertMessage({ from: 'peer', to: 'any', subject: 'after' }).sequence
  ).toBeGreaterThan(message.sequence)
})
