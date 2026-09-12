import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { classifySkillCloudInstallTarget } from './skill-cloud-install-target'

function runtime(usesSsh: boolean): OrcaRuntimeService {
  return {
    skillInstallDestinationUsesSsh: vi.fn().mockResolvedValue(usesSsh)
  } as unknown as OrcaRuntimeService
}

describe('classifySkillCloudInstallTarget', () => {
  it('treats paired runtimes and SSH-owned workspaces as remote', async () => {
    await expect(
      classifySkillCloudInstallTarget(runtime(false), {
        environmentId: 'environment_1',
        destination: { scope: 'global' }
      })
    ).resolves.toBe('remote')
    await expect(
      classifySkillCloudInstallTarget(runtime(true), {
        destination: { scope: 'workspace', worktreeId: 'worktree_1' }
      })
    ).resolves.toBe('remote')
  })

  it('keeps native and WSL installs in the local grant lane', async () => {
    await expect(
      classifySkillCloudInstallTarget(runtime(false), {
        destination: { scope: 'global', executionTarget: { kind: 'wsl', distro: 'Ubuntu' } }
      })
    ).resolves.toBe('local')
  })
})
