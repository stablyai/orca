import { describe, expect, it } from 'vitest'
import { confirmPreservedEndpointLoss } from '../daemon-preserved-endpoint-loss'
import { DaemonProtocolError } from '../../../protocol/daemon-errors'

function connectError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code, syscall: 'connect' })
}

const sleep = async (): Promise<void> => {}

/** Replays connect outcomes in order; once spent, the caller no longer needs a verdict. */
function script(outcomes: (Error | 'ok')[]) {
  let index = 0
  return {
    connect: async () => {
      const outcome = outcomes[index++]
      if (outcome instanceof Error) {
        throw outcome
      }
    },
    shouldContinue: () => index < outcomes.length
  }
}

describe('confirmPreservedEndpointLoss', () => {
  it('is gone after three refused or missing attempts in a row with the process gone', async () => {
    const run = script([
      connectError('ECONNREFUSED'),
      connectError('ENOENT'),
      connectError('ECONNREFUSED')
    ])
    await expect(
      confirmPreservedEndpointLoss({ ...run, processExited: () => true, delaysMs: [1], sleep })
    ).resolves.toBe('gone')
  })

  it('restarts the count on a timeout or other failure instead of reading it as death', async () => {
    const run = script([
      connectError('ENOENT'),
      connectError('ENOENT'),
      new DaemonProtocolError('Connection timed out'),
      connectError('EPERM'),
      connectError('ENOENT'),
      connectError('ENOENT')
    ])
    await expect(
      confirmPreservedEndpointLoss({ ...run, processExited: () => true, delaysMs: [1], sleep })
    ).resolves.toBe('abandoned')
  })

  it('keeps checking after an unproven attempt, so a host that dies later is still caught', async () => {
    const run = script([
      new DaemonProtocolError('Connection timed out'),
      connectError('ENOENT'),
      connectError('ENOENT'),
      connectError('ENOENT'),
      connectError('ENOENT')
    ])
    await expect(
      confirmPreservedEndpointLoss({ ...run, processExited: () => true, delaysMs: [1], sleep })
    ).resolves.toBe('gone')
  })

  it('never declares loss while the daemon process may still be alive', async () => {
    const run = script(Array.from({ length: 10 }, () => connectError('ECONNREFUSED')))
    await expect(
      confirmPreservedEndpointLoss({ ...run, processExited: () => false, delaysMs: [1], sleep })
    ).resolves.toBe('abandoned')
  })

  it('stops when the host answers again', async () => {
    const run = script([connectError('ECONNREFUSED'), 'ok', connectError('ECONNREFUSED')])
    await expect(
      confirmPreservedEndpointLoss({ ...run, processExited: () => true, delaysMs: [1], sleep })
    ).resolves.toBe('reachable')
  })
})
