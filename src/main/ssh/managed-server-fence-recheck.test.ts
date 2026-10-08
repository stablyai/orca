import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  FENCE_RECHECK_INTERVAL_MS,
  recheckFencedManagedServer,
  scheduleManagedServerFenceRecheck
} from './managed-server-fence-recheck'
import { MANAGED_ORCAD_FENCED_DETAIL } from './orcad-managed-serving'

const TARGET: SshTarget = { id: 'box', label: 'Box', host: 'box', port: 22, username: 'me' }

function hostDeps(states: ('fenced' | 'serving')[], update: 'fence-busy' | 'current') {
  return {
    ensureServing: vi.fn(async () =>
      states.shift() === 'fenced'
        ? { state: 'unverifiable' as const, detail: MANAGED_ORCAD_FENCED_DETAIL }
        : { state: 'serving' as const }
    ),
    autoUpdate: vi.fn(async () =>
      update === 'fence-busy'
        ? {
            outcome: 'deferred' as const,
            code: 'orcad_activation_fence_busy',
            reason: 'Another update holds this host.'
          }
        : { outcome: 'skipped' as const, reason: 'current' as const }
    ),
    recordedUpdateFailure: () => null,
    recordUpdateFailure: vi.fn(),
    clearUpdateFailure: vi.fn()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a desktop that met another desktop’s update fence', () => {
  it('rechecks until the host serves again, then publishes it without the note', async () => {
    const deps = hostDeps(['fenced', 'fenced', 'serving'], 'current')
    const publish = vi.fn()
    scheduleManagedServerFenceRecheck(TARGET.id, {
      stillCurrent: () => true,
      recheck: () => recheckFencedManagedServer(TARGET, 'env-1', deps),
      publish
    })

    await vi.advanceTimersByTimeAsync(FENCE_RECHECK_INTERVAL_MS * 2)
    expect(publish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(FENCE_RECHECK_INTERVAL_MS)
    expect(publish).toHaveBeenCalledWith({ route: 'managed', environmentId: 'env-1' })
    await vi.advanceTimersByTimeAsync(FENCE_RECHECK_INTERVAL_MS * 3)
    expect(deps.ensureServing).toHaveBeenCalledTimes(3)
  })

  it('keeps rechecking while the update is still deferred on the fence', async () => {
    const deps = hostDeps(['serving', 'serving'], 'fence-busy')
    const publish = vi.fn()
    scheduleManagedServerFenceRecheck(TARGET.id, {
      stillCurrent: () => true,
      recheck: () => recheckFencedManagedServer(TARGET, 'env-1', deps),
      publish
    })
    await vi.advanceTimersByTimeAsync(FENCE_RECHECK_INTERVAL_MS * 2)
    expect(publish).not.toHaveBeenCalled()
    expect(deps.autoUpdate).toHaveBeenCalledTimes(2)
  })

  it('stops once the host disconnected or another connect took over', async () => {
    const deps = hostDeps(['serving'], 'current')
    const publish = vi.fn()
    scheduleManagedServerFenceRecheck(TARGET.id, {
      stillCurrent: () => false,
      recheck: () => recheckFencedManagedServer(TARGET, 'env-1', deps),
      publish
    })
    await vi.advanceTimersByTimeAsync(FENCE_RECHECK_INTERVAL_MS * 3)
    expect(deps.ensureServing).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})
