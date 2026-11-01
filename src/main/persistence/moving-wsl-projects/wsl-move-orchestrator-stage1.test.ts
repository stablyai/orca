import { describe, expect, it, vi } from 'vitest'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import { wslMoveAutoMovesBridgeProjects } from '../../../shared/wsl-move/wsl-move-rollout-stage'
import { WslMoveOrchestrator } from './wsl-move-orchestrator'
import { fakePorts, stateOf } from './wsl-move-orchestrator.test-support'

// Stage 1 (B3): the WSL hosts setting governs new projects; the user's bridge projects never move on their own.
describe('the move orchestrator in Stage 1', () => {
  const stage1 = () => fakePorts({ autoMovesBridgeProjects: wslMoveAutoMovesBridgeProjects })

  it('ships with automatic moves of bridge projects off', () => {
    expect(wslMoveAutoMovesBridgeProjects()).toBe(false)
  })

  it.each(['project-opened', 'connect', 'startup', 'timer'] as const)(
    'starts no move on a %s wake, and readies no host for one',
    async (trigger) => {
      const ports = stage1()
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', trigger)
      expect(ports.prepareHost).not.toHaveBeenCalled()
      expect(ports.preview).not.toHaveBeenCalled()
      expect(ports.start).not.toHaveBeenCalled()
      expect(stateOf(orchestrator, 'Ubuntu')).toBeUndefined()
    }
  )

  it('still moves when the user asks (their own Retry)', async () => {
    const ports = stage1()
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'user')
    expect(ports.start).toHaveBeenCalledOnce()
  })

  it('still checks a finished move for a removed or replaced distro (R38) on a wake', async () => {
    const loaded = new Map<string, WslMoveOrchestratorRecord>([
      [
        wslMoveJournalKey('Ubuntu'),
        {
          distro: 'Ubuntu',
          state: { kind: 'done', migrationId: 'm1' },
          attempts: 0,
          appVersion: '1.0.0',
          updatedAt: 0
        }
      ]
    ])
    const checkMovedDistro = vi.fn(async () => 'gone' as const)
    const ports = fakePorts({
      autoMovesBridgeProjects: wslMoveAutoMovesBridgeProjects,
      load: () => loaded,
      finishedMove: () => ({ migrationId: 'm1', distroGuid: 'guid' }),
      checkMovedDistro
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'startup')
    expect(checkMovedDistro).toHaveBeenCalledOnce()
    expect(ports.start).not.toHaveBeenCalled()
  })
})
