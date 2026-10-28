import { afterEach, expect, it, vi } from 'vitest'
import { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'

afterEach(() => vi.restoreAllMocks())
it('anchors the commit on receiver preparation, so network and queued delay consume authority without timer delivery', () => {
  let now = 10
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const preparations = new DaemonPtySpawnPreparations(async () => {})
  const receipt = preparations.prepareSwitch('pane', 'connection', 'prepare', 'click')
  now = 20
  const commit = preparations.commitSwitch('pane', 'connection', 'commit', {
    invocationId: 'click',
    anchor: receipt.anchor,
    remainingMs: 100
  })
  expect(preparations.isCanceled(commit)).toBe(false)
  // a+r = 110; receipt-relative 120 would incorrectly allow this continuation.
  now = 111
  expect(preparations.isCanceled(commit)).toBe(true)
  preparations.finish('pane', commit)
})
it('rejects another connection and a reused anchor while the actual selected preparation remains owned', () => {
  const preparations = new DaemonPtySpawnPreparations(async () => {})
  const receipt = preparations.prepareSwitch('pane', 'connection', 'prepare', 'click')
  const execution = { invocationId: 'click', anchor: receipt.anchor, remainingMs: 1000 }
  expect(() => preparations.commitSwitch('pane', 'different', 'commit', execution)).toThrow()
  const selected = preparations.commitSwitch('pane', 'connection', 'commit', execution)
  expect(() => preparations.commitSwitch('pane', 'connection', 'duplicate', execution)).toThrow()
  expect(preparations.isCanceled(selected)).toBe(false)
  preparations.finish('pane', selected)
})
