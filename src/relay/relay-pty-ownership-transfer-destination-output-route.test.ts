import { describe, expect, it, vi } from 'vitest'
import type { RelayDispatcher } from './dispatcher'
import {
  RelayPtyOwnershipTransferDestinationOutputRoute,
  RELAY_PTY_DESTINATION_OUTPUT_NOTIFICATION
} from './relay-pty-ownership-transfer-destination-output-route'
import { identity } from './relay-pty-ownership-transfer-delegation-test-fixture'

function setup() {
  const publishProducerNotification = vi.fn<RelayDispatcher['publishProducerNotification']>(
    () => true
  )
  let active = true
  const route = new RelayPtyOwnershipTransferDestinationOutputRoute({
    dispatcher: { publishProducerNotification },
    clientId: 17,
    identity,
    claim: { generation: 3, claimId: 'claim-3' },
    isActive: () => active,
    windowBytes: 6,
    windowFrames: 2
  })
  return {
    route,
    publishProducerNotification,
    detach: () => {
      active = false
    }
  }
}

describe('claim-bound destination producer route', () => {
  it('targets only the destination and bounds in-flight data until ACK', () => {
    const { route, publishProducerNotification } = setup()
    expect(route.publish({ seq: 1, data: 'one' })).toBe(true)
    expect(route.publish({ seq: 2, data: 'two' })).toBe(true)
    expect(route.publish({ seq: 3, data: 'new' })).toBe(false)
    expect(publishProducerNotification).toHaveBeenCalledTimes(2)
    expect(publishProducerNotification).toHaveBeenCalledWith(
      17,
      RELAY_PTY_DESTINATION_OUTPUT_NOTIFICATION,
      expect.objectContaining({
        ...identity,
        destinationClaim: { generation: 3, claimId: 'claim-3' }
      }),
      { logDrop: false }
    )
    route.acknowledge(1)
    expect(route.publish({ seq: 3, data: 'new' })).toBe(true)
  })

  it('retries admitted-but-unsent data instead of treating credit admission as delivery', () => {
    const { route, publishProducerNotification } = setup()
    publishProducerNotification.mockReturnValueOnce(false)
    const frame = { seq: 1, data: 'one' }
    expect(route.publish(frame)).toBe(false)
    expect(() => route.acknowledge(1)).toThrow('ack_unsent')
    expect(route.publish({ seq: 2, data: 'two' })).toBe(false)
    expect(route.publish(frame)).toBe(true)
    expect(route.publish(frame)).toBe(true)
    expect(publishProducerNotification).toHaveBeenCalledTimes(2)
    expect(route.acknowledge(1).acknowledgedBytes).toBe(3)
  })

  it('retains an immutable pending frame through a thrown producer write and capacity wakeup', () => {
    const { route, publishProducerNotification } = setup()
    publishProducerNotification.mockImplementationOnce(() => {
      throw new Error('write failed')
    })
    const frame = { seq: 1, data: 'one' }
    expect(() => route.publish(frame)).toThrow('write failed')
    frame.data = 'mutated'
    expect(route.flush()).toBe(true)
    expect(publishProducerNotification.mock.calls[1][2]).toMatchObject({
      frame: { seq: 1, data: 'one' }
    })
  })

  it('fences pending sends and ACKs on supersession or disposal', () => {
    const { route, publishProducerNotification, detach } = setup()
    publishProducerNotification.mockReturnValue(false)
    route.publish({ seq: 1, data: 'one' })
    detach()
    expect(route.flush()).toBe(false)
    expect(() => route.acknowledge(0)).toThrow('route_stale')
    expect(publishProducerNotification).toHaveBeenCalledTimes(1)
    const another = setup()
    another.route.dispose()
    expect(another.route.publish({ seq: 1, data: 'one' })).toBe(false)
  })

  it('rejects conflicting retries, sequence gaps and ACKs for unpublished frames', () => {
    const { route, publishProducerNotification } = setup()
    publishProducerNotification.mockReturnValueOnce(false)
    route.publish({ seq: 1, data: 'one' })
    expect(() => route.publish({ seq: 1, data: 'bad' })).toThrow('conflict')
    route.flush()
    expect(() => route.publish({ seq: 3, data: 'gap' })).toThrow('sequence_gap')
    expect(() => route.acknowledge(2)).toThrow('ack_unsent')
  })
})
