import { describe, expect, it, vi } from 'vitest'
import { confirmPreservedEndpointLoss } from '../daemon-preserved-endpoint-loss'
import { DaemonProtocolError } from '../../../protocol/daemon-errors'

function connectError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code, syscall: 'connect' })
}

const sleep = async (): Promise<void> => {}

describe('confirmPreservedEndpointLoss', () => {
  it('is gone only when every attempt finds the endpoint refused or missing', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(connectError('ECONNREFUSED'))
      .mockRejectedValueOnce(connectError('ENOENT'))
      .mockRejectedValueOnce(connectError('ECONNREFUSED'))
    await expect(
      confirmPreservedEndpointLoss({
        connect,
        shouldContinue: () => true,
        delaysMs: [1, 1, 1],
        sleep
      })
    ).resolves.toBe('gone')
    expect(connect).toHaveBeenCalledTimes(3)
  })

  it('never reads a timeout or other failure as death', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(connectError('ENOENT'))
      .mockRejectedValueOnce(new DaemonProtocolError('Connection timed out'))
    await expect(
      confirmPreservedEndpointLoss({
        connect,
        shouldContinue: () => true,
        delaysMs: [1, 1, 1],
        sleep
      })
    ).resolves.toBe('unproven')
    const eperm = vi.fn().mockRejectedValue(connectError('EPERM'))
    await expect(
      confirmPreservedEndpointLoss({
        connect: eperm,
        shouldContinue: () => true,
        delaysMs: [1],
        sleep
      })
    ).resolves.toBe('unproven')
  })

  it('stops when the host answers again', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(connectError('ECONNREFUSED'))
      .mockResolvedValueOnce(undefined)
    await expect(
      confirmPreservedEndpointLoss({
        connect,
        shouldContinue: () => true,
        delaysMs: [1, 1, 1],
        sleep
      })
    ).resolves.toBe('reachable')
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('stops without a verdict once the adapter no longer needs one', async () => {
    const connect = vi.fn().mockRejectedValue(connectError('ECONNREFUSED'))
    let live = true
    connect.mockImplementationOnce(async () => {
      live = false
      throw connectError('ECONNREFUSED')
    })
    await expect(
      confirmPreservedEndpointLoss({
        connect,
        shouldContinue: () => live,
        delaysMs: [1, 1, 1],
        sleep
      })
    ).resolves.toBe('abandoned')
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
