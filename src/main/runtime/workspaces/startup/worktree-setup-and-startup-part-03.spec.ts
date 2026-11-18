import '../../../../shared/orca-profiles/constants'
import { describe, expect, it, vi } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { addWorktree } from '../../../git/worktrees/creation/worktree-add'
import '../../orca-runtime-test-mocks/setup.spec'
import '../../../workspace-hooks/worktree-runner-script'
import '../../../workspace-hooks/effective-hook-config'
import '../../../workspace-hooks/hooks'
import '../../../git/worktrees/catalog/worktree-scan-cache'

import {
  TEST_REPO_ID,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import '../../terminal/launch/spawned-pty-env-fixtures'

import '../../../../shared/workspace-layout/layout-owner-switch'

describe('OrcaRuntimeService', () => {
  it('rejects explicit startup commands for disabled selected agents', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex' as const]
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-disabled-startup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'disabled-startup',
        startup: { command: 'codex' },
        createdWithAgent: 'codex'
      })
    ).rejects.toThrow('Selected agent is disabled. Choose an enabled agent before creating.')

    expect(spawn).not.toHaveBeenCalled()
    expect(addWorktree).not.toHaveBeenCalled()
  })
})
