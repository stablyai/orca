import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  currentPairingDaemonPids,
  pairingDaemonPidsFromUserData,
  pairingRuntimePidFromUserData,
  signalPairingDaemons,
  signalPairingRuntime
} from '../../scripts/emulator-pairing-runtime-process.mjs'

describe('emulator pairing runtime process ownership', () => {
  it('reads the Electron owner pid from its isolated runtime metadata', () => {
    const readText = vi.fn(() => JSON.stringify({ pid: 4102 }))

    expect(pairingRuntimePidFromUserData('/tmp/isolated-profile', readText)).toBe(4102)
    expect(readText).toHaveBeenCalledWith(path.join('/tmp/isolated-profile', 'orca-runtime.json'))
  })

  it('rejects missing, malformed, and unsafe runtime pids', () => {
    expect(pairingRuntimePidFromUserData('/tmp/profile', () => '{')).toBeNull()
    expect(pairingRuntimePidFromUserData('/tmp/profile', () => '{"pid":0}')).toBeNull()
    expect(pairingRuntimePidFromUserData('/tmp/profile', () => '{"pid":1.5}')).toBeNull()
  })

  it('reads only daemon pids owned by the isolated profile', () => {
    const readDirectory = vi.fn(() => [
      'daemon-v26.pid',
      'daemon-v27.pid',
      'daemon-v27.token',
      'notes.txt'
    ])
    const readText = vi.fn((filePath: string) =>
      filePath.endsWith('daemon-v26.pid') ? '{"pid":5201}' : '{"pid":5202}'
    )

    expect(pairingDaemonPidsFromUserData('/tmp/isolated-profile', readDirectory, readText)).toEqual(
      [5201, 5202]
    )
    expect(readText).toHaveBeenCalledTimes(2)
  })

  it('ignores unavailable, malformed, and unsafe daemon pid records', () => {
    expect(
      pairingDaemonPidsFromUserData(
        '/tmp/profile',
        () => ['daemon-v25.pid', 'daemon-v26.pid'],
        (filePath) => (filePath.endsWith('v25.pid') ? '{' : '{"pid":0}')
      )
    ).toEqual([])
    expect(
      pairingDaemonPidsFromUserData('/tmp/profile', () => {
        throw new Error('missing')
      })
    ).toEqual([])
  })

  it('includes daemon pid files created after the pairing URL was emitted', () => {
    expect(
      currentPairingDaemonPids(
        '/tmp/profile',
        [5201],
        () => ['daemon-v36.pid'],
        () => JSON.stringify({ pid: 5202 })
      )
    ).toEqual([5201, 5202])
  })

  it('signals the Electron owner rather than relying on its CLI wrapper', () => {
    const sendSignal = vi.fn()

    signalPairingRuntime(4102, sendSignal)
    signalPairingRuntime(null, sendSignal)

    expect(sendSignal).toHaveBeenCalledOnce()
    expect(sendSignal).toHaveBeenCalledWith(4102, 'SIGTERM')
  })

  it('signals every daemon captured from the disposable profile', () => {
    const sendSignal = vi.fn()

    signalPairingDaemons([5201, 5202], sendSignal)

    expect(sendSignal).toHaveBeenNthCalledWith(1, 5201, 'SIGTERM')
    expect(sendSignal).toHaveBeenNthCalledWith(2, 5202, 'SIGTERM')
  })

  it('supports forced shutdown only for the captured disposable daemons', () => {
    const sendSignal = vi.fn()

    signalPairingDaemons([5201], sendSignal, 'SIGKILL')

    expect(sendSignal).toHaveBeenCalledWith(5201, 'SIGKILL')
  })

  it('tolerates a captured daemon exiting before it can be signaled', () => {
    const error = Object.assign(new Error('gone'), { code: 'ESRCH' })

    expect(() =>
      signalPairingDaemons([5201], () => {
        throw error
      })
    ).not.toThrow()
  })
})
