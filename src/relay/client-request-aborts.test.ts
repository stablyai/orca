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
    const registrations = Array.from(
      { length: MAX_ACTIVE_RELAY_REQUESTS_PER_CLIENT },
      (_, requestId) => requests.create(1, requestId)
    )

    expect(() => requests.create(1, MAX_ACTIVE_RELAY_REQUESTS_PER_CLIENT)).toThrow(
      `Relay client active request limit of ${MAX_ACTIVE_RELAY_REQUESTS_PER_CLIENT} reached`
    )

    requests.delete(registrations[0].key)
    expect(() => requests.create(1, MAX_ACTIVE_RELAY_REQUESTS_PER_CLIENT)).not.toThrow()
  })

  it('accepts the aggregate request boundary without evicting active clients', () => {
    const requests = new ClientRequestAborts()
    for (let index = 0; index < MAX_ACTIVE_RELAY_REQUESTS; index += 1) {
      const clientId = Math.floor(index / MAX_ACTIVE_RELAY_REQUESTS_PER_CLIENT) + 1
      requests.create(clientId, index)
    }

    expect(() => requests.create(99, MAX_ACTIVE_RELAY_REQUESTS)).toThrow(
      `Relay active request limit of ${MAX_ACTIVE_RELAY_REQUESTS} reached`
    )
    expect(requests.get(1, 0)?.signal.aborted).toBe(false)

    requests.delete({ clientId: 1, requestId: 0 })
    expect(() => requests.create(99, MAX_ACTIVE_RELAY_REQUESTS)).not.toThrow()
  })

  it('bounds retained payload bytes per client and releases the budget on delete', () => {
    const requests = new ClientRequestAborts()
    const halfBudget = MAX_ACTIVE_RELAY_REQUEST_BYTES_PER_CLIENT / 2
    const first = requests.create(1, 1, halfBudget)
    requests.create(1, 2, halfBudget)

    expect(() => requests.create(1, 3, 1)).toThrow(
      `Relay client active request payload limit of ${MAX_ACTIVE_RELAY_REQUEST_BYTES_PER_CLIENT} bytes exceeded`
    )

    requests.delete(first.key)
    expect(() => requests.create(1, 3, 1)).not.toThrow()
  })

  it('bounds aggregate retained payload bytes and recovers after client abort', () => {
    const requests = new ClientRequestAborts()
    requests.create(1, 1, MAX_ACTIVE_RELAY_REQUEST_BYTES_PER_CLIENT)
    requests.create(
      2,
      2,
      MAX_ACTIVE_RELAY_REQUEST_BYTES - MAX_ACTIVE_RELAY_REQUEST_BYTES_PER_CLIENT
    )

    expect(() => requests.create(3, 3, 1)).toThrow(
      `Relay active request payload limit of ${MAX_ACTIVE_RELAY_REQUEST_BYTES} bytes exceeded`
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
