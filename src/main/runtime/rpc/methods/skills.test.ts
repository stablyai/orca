import { describe, expect, it, vi } from 'vitest'
import { codexSkillInventory } from '../../../skills/codex-skill-inventory-service'
import { SKILL_METHODS } from './skills'

describe('skills.codexSubscribe', () => {
  it('streams app-server watcher invalidation and removes the listener on cleanup', async () => {
    const method = SKILL_METHODS.find((candidate) => candidate.name === 'skills.codexSubscribe')
    if (!method || !('stream' in method)) {
      throw new Error('skills.codexSubscribe must be streaming')
    }
    let cleanup = (): void => {}
    const emit = vi.fn()
    const running = method.handler(
      undefined,
      {
        runtime: {
          registerSubscriptionCleanup: (_id: string, nextCleanup: () => void) => {
            cleanup = nextCleanup
          }
        } as never,
        connectionId: 'connection-1'
      },
      emit
    )
    codexSkillInventory.emit('changed')
    expect(emit).toHaveBeenCalledWith({ type: 'changed' })
    cleanup()
    await running
    emit.mockClear()
    codexSkillInventory.emit('changed')
    expect(emit).not.toHaveBeenCalled()
  })
})
