import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostTaskPreferenceOperations } from './web-host-task-preference-operations'

describe('web host task preference operations', () => {
  it('uses strict task updates and the existing opaque trust operation', async () => {
    const updateResume = vi.fn().mockResolvedValue(null)
    const updateSettings = vi.fn().mockResolvedValue(null)
    const persistTrust = vi.fn().mockResolvedValue({
      'repo-page-1': { all: { approvedAt: 10 } }
    })
    const operations = webHostTaskPreferenceOperations({
      task: { updateResume, updateSettings },
      workspaceCreation: { persistTrust }
    } as unknown as MobileWebBridgeClient)

    await operations.updateResume({ githubMode: 'project' })
    await operations.updateSettings({ defaultTaskSource: 'linear' })
    await expect(
      operations.persistSetupTrust({
        trust: {},
        repoId: 'repo-page-1',
        contentHash: 'f'.repeat(64),
        alwaysTrust: true
      })
    ).resolves.toEqual({
      'repo-page-1': { all: { approvedAt: 10 } }
    })

    expect(updateResume).toHaveBeenCalledWith({
      taskResumeState: { githubMode: 'project' }
    })
    expect(updateSettings).toHaveBeenCalledWith({ defaultTaskSource: 'linear' })
    expect(persistTrust).toHaveBeenCalledWith({
      trust: {},
      repoId: 'repo-page-1',
      contentHash: 'f'.repeat(64),
      alwaysTrust: true
    })
  })
})
