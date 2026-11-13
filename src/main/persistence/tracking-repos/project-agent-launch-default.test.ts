import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestStores, createStore, makeRepo, testState } from '../persistence-test-harness'
import { ProjectUpdate } from '../../../shared/rpc-contract/project-runtime-params'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-project-ai-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('persists a project launch choice across restart without changing another project and clears it durably', async () => {
  const store = createStore()
  store.addRepo(makeRepo({ id: 'project-a', path: join(testState.dir, 'a') }))
  store.addRepo(makeRepo({ id: 'project-b', path: join(testState.dir, 'b') }))
  const project = store.getProjects().find((row) => row.sourceRepoIds.includes('project-a'))!
  const request = ProjectUpdate.parse({
    projectId: project.id,
    updates: {
      agentLaunchDefault: {
        agent: 'codex',
        surface: 'chat',
        choices: { model: 'codex-project-model', options: { effort: 'high' } }
      }
    }
  })
  store.updateProject(request.projectId, request.updates)
  store.flush()
  await closeTestStores()
  const reopened = createStore()
  expect(reopened.getProjects().find((row) => row.id === project.id)?.agentLaunchDefault).toEqual({
    agent: 'codex',
    surface: 'chat',
    choices: { model: 'codex-project-model', options: { effort: 'high' } }
  })
  expect(
    reopened.getProjects().find((row) => row.sourceRepoIds.includes('project-b'))
      ?.agentLaunchDefault
  ).toBeUndefined()
  reopened.updateProject(project.id, { agentLaunchDefault: null })
  reopened.flush()
  await closeTestStores()
  expect(
    createStore()
      .getProjects()
      .find((row) => row.id === project.id)?.agentLaunchDefault
  ).toBeNull()
})
