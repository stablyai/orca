import { expect, it, vi } from 'vitest'
import { runtimeEnvironmentsApi } from './runtime-environments-bridge'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))

it('passes explicit reconciliation intent unchanged through the desktop IPC bridge', async () => {
  const request = { action: 'reverse' as const, environmentId: 'historical', requestId: 'request' }
  const result = { record: null }
  invoke.mockResolvedValueOnce(result)
  await expect(runtimeEnvironmentsApi.reconcile(request)).resolves.toBe(result)
  expect(invoke).toHaveBeenCalledExactlyOnceWith('runtimeEnvironments:reconcile', request)
})
