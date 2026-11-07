import './orca-runtime-tests/runtime-test-module-registration.spec'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrcaRuntimeService } from './orca-runtime'
import {
  TEST_FOLDER_WORKSPACE_KEY,
  createFolderWorkspaceRuntimeStore,
  makeFolderWorkspace
} from './orca-runtime-tests/orca-runtime-test-fixtures.spec'

describe('section trust ownership', () => {
  it.each([false, true])(
    'carries transient section trust ownership through host creation (override %s)',
    async (section) => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-section-trust' })
      const folderPath = await mkdtemp(join(tmpdir(), 'orca-pr38831-trust-root-'))
      const childPath = await mkdtemp(join(tmpdir(), 'orca-pr38831-trust-child-'))
      const trustWorktreeId = `repo::${childPath}`
      const folder = makeFolderWorkspace({ folderPath })
      const runtime = new OrcaRuntimeService(createFolderWorkspaceRuntimeStore(folder))
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      try {
        await runtime.createAgentSession({
          clientOperationId: `${Date.now()}-${'ab'.repeat(16)}`,
          worktree: `id:${TEST_FOLDER_WORKSPACE_KEY}`,
          agent: 'claude',
          startupCwd: childPath,
          ...(section ? { trustWorktreeId } : {})
        })
        expect(spawn.mock.calls[0]?.[0]).toMatchObject({
          worktreeId: TEST_FOLDER_WORKSPACE_KEY,
          cwd: childPath
        })
        if (section) {
          expect(spawn.mock.calls[0]?.[0]?.trustWorktreeId).toBe(trustWorktreeId)
        } else {
          expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('trustWorktreeId')
        }
      } finally {
        await rm(folderPath, { recursive: true, force: true })
        await rm(childPath, { recursive: true, force: true })
      }
    }
  )
})
