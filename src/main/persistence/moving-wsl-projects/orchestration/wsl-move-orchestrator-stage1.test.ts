import { describe, expect, it } from 'vitest'

import { wslMoveAutoMovesBridgeProjects } from '../../../../shared/wsl-move/wsl-move-rollout-stage'
import { WslMoveOrchestrator } from '../wsl-move-orchestrator'
import { fakePorts } from './wsl-move-orchestrator.test-support'

// Stage 1 (B3): the WSL hosts setting governs new projects; the user's bridge projects never move on their own.
describe('the move orchestrator in Stage 1', () => {
  const stage1 = () => fakePorts({ autoMovesBridgeProjects: wslMoveAutoMovesBridgeProjects })

  it('still moves when the user asks (their own Retry)', async () => {
    const ports = stage1()
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'user')
    expect(ports.start).toHaveBeenCalledOnce()
  })
})
