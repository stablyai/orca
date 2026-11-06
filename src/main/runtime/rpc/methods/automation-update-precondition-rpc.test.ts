import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AUTOMATION_METHODS } from './automations'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

// The CLI's setup choice is only safe if the params schema keeps this precondition instead of stripping it.
describe('automation.update precondition', () => {
  it('preserves null baseBranch and the workspace-mode precondition through the RPC boundary', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automation.update calls only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateAutomation: vi.fn().mockResolvedValue({ id: 'auto-1', baseBranch: null })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await dispatcher.dispatch(
      makeRequest('automation.update', {
        id: 'auto-1',
        updates: { baseBranch: null },
        expectedWorkspaceMode: 'new_per_run'
      })
    )

    expect(runtime.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      { baseBranch: null },
      { expectedOwner: undefined, destination: undefined, expectedWorkspaceMode: 'new_per_run' }
    )
  })
})
