import { describe, expect, it, vi } from 'vitest'
import { RuntimeAutomationController } from './runtime-automation-controller'

function setup(current: Record<string, unknown>) {
  const store = {
    listAutomations: () => [current],
    updateAutomation: vi.fn((_id: string, patch: Record<string, unknown>) => ({
      ...current,
      ...patch
    })),
    flushPendingOrThrowAsync: async () => {}
  }
  const resolvers = {
    showRepo: vi.fn(async () => ({ id: 'repo-1', path: '/repo' })),
    showManagedWorktree: vi.fn(async () => {
      throw new Error('unexpected worktree lookup')
    })
  }
  const controller = new RuntimeAutomationController(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: update() reads only these store members on the tested paths.
    store as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only target-changing updates call the resolvers.
    resolvers as never
  )
  return { controller, store }
}

const EXISTING_AUTOMATION = {
  id: 'auto-1',
  projectId: 'repo-1',
  workspaceMode: 'existing',
  reuseSession: true
}

describe('automation update session-reuse pairing', () => {
  it('rejects skip when the stored automation does not reuse a session', async () => {
    const { controller, store } = setup({ ...EXISTING_AUTOMATION, reuseSession: false })

    await expect(
      controller.update('auto-1', { onNoReusableSession: 'skip' })
    ).rejects.toThrow('requires session reuse')
    expect(store.updateAutomation).not.toHaveBeenCalled()
  })

  it('rejects skip when the patch turns session reuse off', async () => {
    const { controller, store } = setup(EXISTING_AUTOMATION)

    await expect(
      controller.update('auto-1', { onNoReusableSession: 'skip', reuseSession: false })
    ).rejects.toThrow('requires session reuse')
    expect(store.updateAutomation).not.toHaveBeenCalled()
  })

  it('rejects skip when a target change forces session reuse off', async () => {
    const { controller, store } = setup(EXISTING_AUTOMATION)

    await expect(
      controller.update('auto-1', { onNoReusableSession: 'skip', workspaceMode: 'new_per_run' })
    ).rejects.toThrow('requires session reuse')
    expect(store.updateAutomation).not.toHaveBeenCalled()
  })

  it('accepts skip when the effective update keeps session reuse', async () => {
    const { controller, store } = setup(EXISTING_AUTOMATION)

    await controller.update('auto-1', { onNoReusableSession: 'skip' })
    expect(store.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      expect.objectContaining({ onNoReusableSession: 'skip' }),
      expect.anything()
    )
  })
})
