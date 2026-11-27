import { describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'
import type * as PlanModule from './wsl-move-driver-plan'

const prepareWslMove = vi.hoisted(() => vi.fn())
vi.mock('./wsl-move-driver-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof PlanModule>()),
  prepareWslMove
}))

const { previewWslMove } = await import('./wsl-move-driver-preview')

function depsWithWait(wait: (ms: number) => Promise<void>): WslMoveDriverDeps {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preview reads only these.
  return {
    newMigrationId: () => 'migration-1',
    now: () => new Date(0),
    quiesce: { wait }
  } as unknown as WslMoveDriverDeps
}

describe('previewWslMove', () => {
  it('retries once when the host is briefly unavailable', async () => {
    const refused = { outcome: 'refused', code: 'wsl_move_nothing_new' }
    prepareWslMove
      .mockRejectedValueOnce(new RemoteRuntimeClientError('remote_runtime_unavailable', 'Closed.'))
      .mockResolvedValueOnce(refused)
    const wait = vi.fn(async () => {})
    await expect(previewWslMove(depsWithWait(wait), { distro: 'Ubuntu' })).resolves.toEqual(refused)
    expect(prepareWslMove).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)
  })
})
