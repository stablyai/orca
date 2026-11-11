import { describe, expect, it, vi } from 'vitest'
import type { WslMovePreview } from '../../../shared/wsl-move/wsl-move-driver-types'
import { WslMoveOrchestrator } from './wsl-move-orchestrator'
import { fakePorts, ready, stateOf } from './wsl-move-orchestrator.test-support'

// The orchestrator under the user's own choices and the reviews' race and failure cases.
describe('WslMoveOrchestrator: user choices, races and failures', () => {
  describe('re-review fixes (#33802)', () => {
    // 1: an unreadable journal at startup must not escape the constructor.

    // 2: a release by the user during a step must win over the step's stale view.
    it('does not move a distro the user released while its preview was running', async () => {
      let release: () => void = () => {}
      const ports = fakePorts({
        preview: vi.fn(
          () =>
            new Promise<WslMovePreview>((resolve) => {
              release = () => resolve(ready('Ubuntu'))
            })
        )
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      const step = orchestrator.trigger('Ubuntu', 'connect')
      await vi.waitFor(() => expect(ports.preview).toHaveBeenCalled())
      orchestrator.releasedByUser('Ubuntu', 'released-here')
      release()
      await step
      expect(ports.start).not.toHaveBeenCalled()
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({
        kind: 'parked',
        reason: 'declined',
        cause: 'released-here'
      })
    })

    // 3: a wake queued during Restore's own busy section runs after it.
  })

  // Pre-review #1: a pruned decline would let a later wake re-add a host the user removed.

  // #34632's stopped-distro gates: the user's Check again is their act on the distro, so the
  // driver's reads for a just-connected distro are not refused as background work.
})
