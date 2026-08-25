import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetupExistingFolderArgs } from '../../shared/project-types'
import {
  setSshProjectSetupExistingFolderHandler,
  setupRegisteredSshProjectExistingFolder
} from './ssh-project-setup-registry'

describe('SSH project setup registry', () => {
  afterEach(() => setSshProjectSetupExistingFolderHandler(null))

  it('delegates to the desktop-owned SSH project setup path', async () => {
    const args = {
      projectId: 'github:stablyai/orca',
      hostId: 'ssh:ssh-1',
      path: '/work/orca',
      kind: 'git' as const
    } satisfies ProjectHostSetupExistingFolderArgs
    const result = {
      project: { id: args.projectId },
      setup: { id: 'setup-1' },
      repo: { id: 'repo-1' }
    }
    const handler = vi.fn().mockResolvedValue(result)
    setSshProjectSetupExistingFolderHandler(handler)

    await expect(setupRegisteredSshProjectExistingFolder(args)).resolves.toBe(result)
    expect(handler).toHaveBeenCalledWith(args)
  })
})
