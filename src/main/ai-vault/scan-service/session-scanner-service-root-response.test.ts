import { expect, it, vi } from 'vitest'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import {
  AiVaultServiceTestChild,
  readyAiVaultServiceChild
} from './session-scanner-service-test-child'

it('does not deliver a delayed snapshot after the child is disposed', async () => {
  const child = new AiVaultServiceTestChild()
  Object.assign(child, { connected: true })
  const pending = Promise.withResolvers<{}>()
  const resolveSessionSearchRoots = vi.fn(() => pending.promise)
  const client = new AiVaultScannerServiceClient({
    processFactory: () => child.asChildProcess(),
    init: () => ({ sessionSearch: null, sessionParseCache: null }),
    resolveSessionSearchRoots
  })
  const status = client.request({ type: 'request', operation: 'searchStatus' })
  readyAiVaultServiceChild(child)
  await Promise.resolve()
  child.emit('message', { type: 'result', operation: 'searchStatus', id: 1, value: {} })
  await status
  child.emit('message', { type: 'sessionSearchRoots', id: 5 })
  await vi.waitFor(() => expect(resolveSessionSearchRoots).toHaveBeenCalledTimes(1))
  client.dispose()
  pending.resolve({})
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(child.sent).not.toContainEqual(expect.objectContaining({ type: 'sessionSearchRoots' }))
})
