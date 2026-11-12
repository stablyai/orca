import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { RuntimeAutomationController } from './runtime-automation-controller'

describe('creating an automation for a plugin', () => {
  it('writes nothing when the plugin loses approval while the target resolves', async () => {
    let approved = true
    const createAutomation = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create reads only these store members.
    const store = { createAutomation } as never
    const controller = new RuntimeAutomationController(store, {
      showRepo: async () => {
        // The person disables the plugin while Orca resolves the project.
        approved = false
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create reads id and path only.
        return { id: 'r1', path: '/src/r1' } as Repo
      },
      showManagedWorktree: vi.fn()
    })
    await expect(
      controller.create(
        {
          name: 'Nightly',
          prompt: 'Check',
          agentId: 'claude',
          repo: 'id:r1',
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
          dtstart: 1
        },
        undefined,
        () => {
          if (!approved) {
            throw new Error('plugin is no longer enabled')
          }
        }
      )
    ).rejects.toThrow('plugin is no longer enabled')
    expect(createAutomation).not.toHaveBeenCalled()
  })
})
