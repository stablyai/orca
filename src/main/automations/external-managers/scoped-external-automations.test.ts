import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAutomationManager } from '../../../shared/automations/external/external-automation'
import type { ScopedExternalManagerListRequest } from '../../../shared/automations/external/external-automation-scope'
import { ExternalAutomationManagerCache } from './external-automation-manager-cache'
import { ExternalAutomationProbeScheduler } from './external-automation-probe-scheduler'
import { listLocalManager } from './external-manager-discovery'
import { createScopedExternalAutomations } from './scoped-external-automations'

vi.mock('./external-manager-discovery', () => ({ listLocalManager: vi.fn() }))
vi.mock('./external-manager-mutations', () => ({
  runExternalAutomationAction: vi.fn(async () => undefined)
}))

const request: ScopedExternalManagerListRequest = {
  owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
  provider: 'openclaw'
}

function manager(label: string): ExternalAutomationManager {
  return {
    id: 'openclaw:local',
    provider: 'openclaw',
    label,
    targetLabel: 'This computer',
    target: { type: 'local' },
    status: 'available',
    error: null,
    canManage: true,
    jobs: []
  }
}

describe('scoped external automations', () => {
  beforeEach(() => {
    vi.mocked(listLocalManager).mockReset()
  })

  it('does not reuse or cache a probe that began before an action', async () => {
    let releaseStaleRead!: (value: ExternalAutomationManager) => void
    vi.mocked(listLocalManager)
      .mockImplementationOnce(() => new Promise((resolve) => (releaseStaleRead = resolve)))
      .mockResolvedValue(manager('after action'))
    const automations = createScopedExternalAutomations({
      registry: { getSshTargets: () => [] },
      scheduler: new ExternalAutomationProbeScheduler(),
      cache: new ExternalAutomationManagerCache()
    })

    const readBeforeAction = automations.listManager(request)
    await automations.runAction({ ...request, jobId: 'job-1', action: 'pause' })
    const readAfterAction = automations.listManager(request)
    releaseStaleRead(manager('before action'))
    await readBeforeAction

    expect((await readAfterAction).manager?.label).toBe('after action')
    expect((await automations.listManager(request)).manager?.label).toBe('after action')
  })
})
