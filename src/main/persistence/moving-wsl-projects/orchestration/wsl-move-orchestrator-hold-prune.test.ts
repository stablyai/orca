import { describe, expect, it, vi } from 'vitest'
import { WslMoveOrchestrator } from '../wsl-move-orchestrator'
import { fakePorts, stateOf } from './wsl-move-orchestrator.test-support'

describe('holds after a set-aside sidecar', () => {
  it('prunes, in the same launch, a hold whose distro turns out unused', async () => {
    // Held at listing time (the check failed safe), then definitely unused by the prune after it.
    const inUse = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const ports = fakePorts({
      load: () => ({
        kind: 'readable',
        records: new Map(),
        unknownKeys: new Set(),
        holdDistrosOnceListed: true
      }),
      listKnownDistros: async () => ['Debian'],
      isDistroInUse: inUse
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.whenIdle()
    expect(inUse).toHaveBeenCalledTimes(2)
    expect(stateOf(orchestrator, 'Debian')).toBeUndefined()
    orchestrator.dispose()
  })

  it('keeps the hold while the distro stays in use', async () => {
    const ports = fakePorts({
      load: () => ({
        kind: 'readable',
        records: new Map(),
        unknownKeys: new Set(),
        holdDistrosOnceListed: true
      }),
      listKnownDistros: async () => ['Debian'],
      isDistroInUse: vi.fn(async () => true)
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.whenIdle()
    expect(stateOf(orchestrator, 'Debian')).toMatchObject({ kind: 'parked', stateLost: true })
    orchestrator.dispose()
  })
})
