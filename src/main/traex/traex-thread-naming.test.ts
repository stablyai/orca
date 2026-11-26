import { afterEach, expect, it, vi } from 'vitest'
import { TraexAppServerConnection } from './traex-app-server-connection'
import { TraexThreadNaming } from './traex-thread-naming'
import { traexRecord } from './traex-protocol'

vi.mock('./traex-app-server-connection')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('keeps the next naming attempt after an expired request fails', async () => {
  vi.useFakeTimers()
  const connection = new TraexAppServerConnection({
    command: process.execPath,
    args: [],
    cwd: '/workspace'
  })
  vi.spyOn(connection, 'closed', 'get').mockReturnValue(false)
  const expired = Promise.withResolvers<unknown>()
  const requestIds: string[] = []
  vi.mocked(connection.request).mockImplementation((method, params) => {
    if (method === 'thread/name/generate') {
      const requestId = traexRecord(params).requestId
      if (typeof requestId !== 'string') {
        throw new Error('The naming request has no correlation id')
      }
      requestIds.push(requestId)
      if (requestIds.length === 1) {
        return expired.promise
      }
    }
    return Promise.resolve({})
  })
  const naming = new TraexThreadNaming(connection, 'naming-thread')
  const first = naming.generate()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(await first).toBeNull()
  const next = naming.generate()
  expired.reject(new Error('Expired request failed'))
  await Promise.resolve()
  naming.resolve('Expired attempt title', requestIds[0]!)
  naming.resolve('Second attempt title', requestIds[1]!)
  expect(await next).toBe('Second attempt title')
  naming.dispose()
})
