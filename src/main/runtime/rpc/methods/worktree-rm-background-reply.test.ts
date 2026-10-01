import { describe, expect, it, vi } from 'vitest'
import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function makeRuntime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.rm with an explicit host reads only removeManagedWorktree.
  return {
    getRuntimeId: () => 'test-runtime',
    removeManagedWorktree: vi.fn().mockResolvedValue({})
  } as unknown as OrcaRuntimeService
}

async function dispatchRm(
  runtime: OrcaRuntimeService,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): Promise<void> {
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  await dispatcher.dispatch(
    {
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.rm',
      params: { worktree: 'id:wt-1', hostId: 'local' }
    },
    { clientCapabilities }
  )
}

// Why: the reply may wait out Git's delete only for a client that shows the `removing` marker; an
// older client is answered on acceptance, as its timeouts and listings expect.
describe('worktree.rm waits for the delete only for clients that can show it', () => {
  it('asks the runtime to wait for a client that advertises background removal', async () => {
    expect(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES).toContain(
      WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY
    )
    const runtime = makeRuntime()
    await dispatchRm(runtime, ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ waitForBackgroundRemoval: true })
    )
  })

  it.each([
    ['a client that negotiated no capabilities', undefined],
    ['a client without background removal', []]
  ])('answers %s on acceptance', async (_name, capabilities) => {
    const runtime = makeRuntime()
    await dispatchRm(runtime, capabilities)
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      expect.not.objectContaining({ waitForBackgroundRemoval: true })
    )
  })
})
