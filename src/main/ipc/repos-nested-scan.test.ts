import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return { reposMocks: moduleMocks.createReposIpcMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { getGitRepoRoot, isGitRepo } from '../git/repo'
import { createRepoHandlerHarness, resetProjectGroupMocks } from './repos-remote-test-harness'

const { handleMock, mockStore } = reposMocks

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetSshProviderAuthorities()
})

describe('projectGroups IPC validation', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()

  beforeEach(() => {
    captureHandlers(handleMock)
    mockWindow.webContents.send.mockReset()
    resetProjectGroupMocks(reposMocks, { isGitRepo, getGitRepoRoot })

    registerRepoHandlers(mockWindow as never, mockStore as never, {} as never)
  })

  it('refuses SSH nested scans without reading the remote or the local filesystem', async () => {
    await expect(
      handlers.get('projectGroups:scanNested')!(null, {
        path: '/srv/platform',
        connectionId: 'conn-1'
      })
    ).rejects.toThrow('ssh_connection_unavailable')
    expect(isGitRepo).not.toHaveBeenCalled()
  })

  it('returns partial local scan results after cancellation', async () => {
    vi.mocked(isGitRepo).mockReturnValue(false)
    const root = await mkdtemp(join(tmpdir(), 'orca-nested-local-cancel-'))
    try {
      await mkdir(join(root, 'api', '.git'), { recursive: true })
      await mkdir(join(root, 'web', '.git'), { recursive: true })
      const event = {
        sender: {
          send: vi.fn((_channel: string, data: { scanId: string; scan: { repos: unknown[] } }) => {
            if (data.scan.repos.length === 1) {
              handlers.get('projectGroups:cancelNestedScan')!(null, { scanId: data.scanId })
            }
          })
        }
      }

      const result = await handlers.get('projectGroups:scanNested')!(event, {
        path: root,
        scanId: 'local-scan-1'
      })

      expect(result).toMatchObject({
        selectedPath: root,
        selectedPathKind: 'non_git_folder',
        stopped: true,
        repos: [{ path: join(root, 'api') }]
      })
      expect(event.sender.send).toHaveBeenCalledWith(
        'projectGroups:scanNestedProgress',
        expect.objectContaining({ scanId: 'local-scan-1' })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects local nested scans with relative paths', async () => {
    await expect(
      handlers.get('projectGroups:scanNested')!(null, {
        path: 'relative/project'
      })
    ).rejects.toThrow('Repo path must be an absolute path')
  })
})
