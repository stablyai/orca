import { describe, expect, it } from 'vitest'
import {
  ClientRequestAborts,
  MAX_ACTIVE_RELAY_REQUEST_BYTES,
  MAX_ACTIVE_RELAY_REQUEST_BYTES_PER_CLIENT,
  MAX_ACTIVE_RELAY_REQUESTS,
  MAX_ACTIVE_RELAY_REQUESTS_PER_CLIENT
} from './client-request-aborts'

describe('ClientRequestAborts', () => {
  it('accepts the per-client request boundary, rejects overflow, and recovers', () => {
    const requests = new ClientRequestAborts()
    expect(MAX_ACTIVE_RELAY_REQUESTS_PER_CLIENT).toBe(256)
    const registrations = Array.from({ length: 256 }, (_, requestId) =>
      requests.create(1, requestId)
    )

    expect(() => requests.create(1, 256)).toThrow(
      'Relay client active request limit of 256 reached'
    )

    requests.delete(registrations[0].key)
    expect(() => requests.create(1, 256)).not.toThrow()
  })

  it('accepts the aggregate request boundary without evicting active clients', () => {
    const requests = new ClientRequestAborts()
    expect(MAX_ACTIVE_RELAY_REQUESTS).toBe(1024)
    for (let index = 0; index < 1024; index += 1) {
      const clientId = Math.floor(index / 256) + 1
      requests.create(clientId, index)
    }

    expect(() => requests.create(99, 1024)).toThrow('Relay active request limit of 1024 reached')
    expect(requests.get(1, 0)?.signal.aborted).toBe(false)

    requests.delete({ clientId: 1, requestId: 0 })
    expect(() => requests.create(99, 1024)).not.toThrow()
  })

  it('bounds retained payload bytes per client and releases the budget on delete', () => {
    const requests = new ClientRequestAborts()
    expect(MAX_ACTIVE_RELAY_REQUEST_BYTES_PER_CLIENT).toBe(32 * 1024 * 1024)
    const first = requests.create(1, 1, 16 * 1024 * 1024)
    requests.create(1, 2, 16 * 1024 * 1024)

    expect(() => requests.create(1, 3, 1)).toThrow(
      'Relay client active request payload limit of 33554432 bytes exceeded'
    )

    requests.delete(first.key)
    expect(() => requests.create(1, 3, 1)).not.toThrow()
  })

  it('bounds aggregate retained payload bytes and recovers after client abort', () => {
    const requests = new ClientRequestAborts()
    expect(MAX_ACTIVE_RELAY_REQUEST_BYTES).toBe(64 * 1024 * 1024)
    requests.create(1, 1, 32 * 1024 * 1024)
    requests.create(2, 2, 32 * 1024 * 1024)

    expect(() => requests.create(3, 3, 1)).toThrow(
      'Relay active request payload limit of 67108864 bytes exceeded'
    )

    requests.abortClient(1)
    expect(() => requests.create(3, 3, 1)).not.toThrow()
  })

  it('rejects duplicate ids and releases only the requested owners', () => {
    const requests = new ClientRequestAborts()
    const first = requests.create(1, 7)
    const second = requests.create(2, 7)

    expect(() => requests.create(1, 7)).toThrow('Duplicate active relay request id 7')
    expect(requests.get(1, 7)).toBe(first.controller)

    requests.abortClient(1)
    expect(first.controller.signal.aborted).toBe(true)
    expect(second.controller.signal.aborted).toBe(false)
    expect(requests.get(1, 7)).toBeUndefined()
    expect(requests.get(2, 7)).toBe(second.controller)

    requests.abortAll()
    expect(second.controller.signal.aborted).toBe(true)
    expect(requests.get(2, 7)).toBeUndefined()
  })
})
