import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../rpc/methods/session-tabs/session-tabs'
import { SESSION_TABS_INVENTORY_PUBLICATION_WAIT_MS } from './session-tabs-inventory-publication'

type InventoryInternals = {
  sessionTabsInventoryWaiters: Set<() => void>
}

function createInventoryRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inventory reads only call listProcesses.
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  return runtime
}

function inventoryWaiters(runtime: OrcaRuntimeService): Set<() => void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reads a protected runtime field.
  return (runtime as unknown as InventoryInternals).sessionTabsInventoryWaiters
}

async function waitForInventoryWaiter(runtime: OrcaRuntimeService): Promise<void> {
  await vi.waitFor(() => expect(inventoryWaiters(runtime).size).toBe(1))
}

describe('session tab inventory publication wait', () => {
  it('refuses with runtime_unavailable instead of hanging when no graph ever publishes', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createInventoryRuntime()
      runtime.attachWindow(1)
      const settled = runtime.listAllMobileSessionTabsInventory().catch((error: unknown) => error)
      await waitForInventoryWaiter(runtime)

      await vi.advanceTimersByTimeAsync(SESSION_TABS_INVENTORY_PUBLICATION_WAIT_MS)

      expect(await settled).toEqual(new Error('runtime_unavailable'))
      expect(inventoryWaiters(runtime).size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers an old client over RPC with runtime_unavailable when no graph publishes', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createInventoryRuntime()
      runtime.attachWindow(1)
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
      const messages: string[] = []
      // No clientCapabilities: the pre-capability client shape.
      const pending = dispatcher.dispatchStreaming(
        { id: 'req-1', authToken: 'tok', method: 'session.tabs.listAll' },
        (message) => messages.push(message),
        { clientKind: 'runtime' }
      )
      await waitForInventoryWaiter(runtime)
      await vi.advanceTimersByTimeAsync(SESSION_TABS_INVENTORY_PUBLICATION_WAIT_MS)
      await pending

      expect(JSON.parse(messages[0]!)).toMatchObject({
        ok: false,
        error: { code: 'runtime_unavailable' }
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
