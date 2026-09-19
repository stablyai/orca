import { expect, it, vi } from 'vitest'
import { runtimeEnvironmentsApi } from './runtime-environments-bridge'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))

it('routes explicit outgoing preparation only through the desktop IPC channel', async () => {
  const request = {
    selector: 'destination',
    ptyId: 'ssh:source@@pty',
    surfaceBinding: {
      executionHostId: 'local' as const,
      workspaceKey: 'folder:folder' as const,
      tabId: 'tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      ptyId: 'pty'
    }
  }
  const result = { bridgeId: 'bridge', outcome: 'published' }
  invoke.mockResolvedValueOnce(result)
  await expect(runtimeEnvironmentsApi.prepareOrcadOutgoingTerminal(request)).resolves.toBe(result)
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    'runtimeEnvironments:prepareOrcadOutgoingTerminal',
    request
  )
})
