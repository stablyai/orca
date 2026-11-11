import { describe, expect, it, vi } from 'vitest'
import { WslMoveOrchestrator } from './wsl-move-orchestrator'
import { fakePorts } from './wsl-move-orchestrator.test-support'

describe('WslMoveOrchestrator', () => {
  it('keeps Restore offered when the release is refused', async () => {
    const ports = fakePorts({
      finishedMove: () => ({ migrationId: 'm1' }),
      checkMovedDistro: vi.fn(async () => 'replaced' as const),
      releaseFinishedMove: vi.fn(async () => ({
        released: false as const,
        reason: 'unsaved-files' as const,
        unsavedWorkspaceIds: ['wt']
      }))
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    const { record, release } = await orchestrator.userAction('Ubuntu', 'restore')
    expect(release).toMatchObject({ released: false, reason: 'unsaved-files' })
    expect(record.state).toEqual({ kind: 'restore-offered' })
  })

  // E11 (#33843): a Remove that could not prove the server stopped leaves the host to the user.

  // Review of #34087: the wait cap counts checks, so a restart after days closed does not park.
})
