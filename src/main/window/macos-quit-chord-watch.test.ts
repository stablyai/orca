import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ path: '/helper', spawn: vi.fn() }))
vi.mock('@orca/process-host', () => ({ spawnProcess: mocks.spawn }))
vi.mock('../ipc/macos-keyboard-layout-snapshot', () => ({
  resolveMacKeyboardHelperPath: () => mocks.path
}))
import { watchMacQuitChord } from './macos-quit-chord-watch'

function child() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn()
  })
  mocks.spawn.mockReturnValue(process)
  return process
}
afterEach(() => {
  vi.useRealTimers()
  mocks.spawn.mockReset()
  mocks.path = '/helper'
})

it('requires the native protocol, supports chunked readiness and completes once', () => {
  const native = child()
  const emit = vi.fn()
  watchMacQuitChord('KeyQ', emit)
  native.stdout.write('{"state":"wat')
  native.stdout.write('ching"}\n{"state":"held"}\n{"state":"held"}\n')
  native.emit('close', 0)
  expect(emit.mock.calls).toEqual([['watching'], ['held']])
  expect(native.kill).toHaveBeenCalledOnce()
})

it('ignores all native output after cancellation', () => {
  const native = child()
  const emit = vi.fn()
  const stop = watchMacQuitChord('KeyQ', emit)
  stop()
  native.stdout.write('{"state":"held"}\n')
  native.emit('close', 0)
  expect(emit).not.toHaveBeenCalled()
})

it.each(['older-helper', 'timeout', 'error', 'early-close'])('fails closed for %s', (reason) => {
  vi.useFakeTimers()
  const native = child()
  const emit = vi.fn()
  watchMacQuitChord('KeyQ', emit)
  if (reason === 'older-helper') {
    native.stdout.write('{"keyCharacters":{}}\n')
  }
  if (reason === 'timeout') {
    vi.advanceTimersByTime(3000)
  }
  if (reason === 'error') {
    native.emit('error', new Error('unavailable'))
  }
  if (reason === 'early-close') {
    native.emit('close', 1)
  }
  native.stdout.write('{"state":"held"}\n')
  expect(emit.mock.calls).toEqual([['unavailable']])
})
