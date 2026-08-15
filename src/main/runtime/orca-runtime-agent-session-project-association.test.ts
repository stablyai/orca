import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('runtime agent session project association', () => {
  it('persists a provider hook association before any history list scan', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'orca-runtime-session-project-'))
    temporaryDirectories.push(profile)
    const worktreeId = 'repo-orca::/workspace/worktrees/orca/task-one'
    const runtime = new OrcaRuntimeService({
      getProfileStorageDirectory: () => profile,
      getWorktreeMeta: () => ({ projectId: 'orca' }),
      getProjects: () => [{ id: 'orca', displayName: 'Orca', sourceRepoIds: ['repo-orca'] }]
    } as never)

    runtime.captureAgentSessionProjectAssociation({
      worktreeId,
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'session-1' }
    })

    const filePath = join(profile, 'agent-session-project-associations.json')
    await vi.waitFor(async () => {
      const stored = JSON.parse(await readFile(filePath, 'utf8')) as {
        associations: Record<string, { projectId: string; worktreeId: string }>
      }
      expect(Object.values(stored.associations)).toEqual([
        expect.objectContaining({ projectId: 'orca', worktreeId })
      ])
    })
  })
})
