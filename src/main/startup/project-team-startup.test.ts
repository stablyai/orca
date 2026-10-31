import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const deps = vi.hoisted(() => ({ profile: '', ensure: vi.fn(), close: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => deps.profile, once: vi.fn() } }))
vi.mock('node:fs', () => ({ watch: () => ({ close: deps.close }) }))
vi.mock('../project-teams/project-team-service', () => ({
  ProjectTeamService: class {
    ensure = deps.ensure
  }
}))
vi.mock('../runtime/runtime-reference-catalog', () => ({
  listReferenceWorkspaces: () => [{ id: 'folder', name: 'local folder', path: '/local/folder' }]
}))
vi.mock('../runtime/rpc/dispatcher', () => ({ RpcDispatcher: class {} }))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    runtime: { getRuntimeId: () => 'test' },
    store: {},
    localPtyStartupReady: Promise.resolve()
  }
}))
import { startProjectTeams } from './project-team-startup'

afterEach(async () => {
  if (deps.profile) {
    await rm(deps.profile, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})
it('records one failed team and continues a local folder binding without hostId', async () => {
  deps.profile = await mkdtemp(join(tmpdir(), 'orca-team-startup-'))
  await writeFile(
    join(deps.profile, 'project-teams.json'),
    JSON.stringify({
      version: 1,
      teams: [
        { config: 'invalid.json', projectRoot: '/invalid' },
        { config: 'valid.json', projectRoot: 'workspace:local folder' }
      ]
    })
  )
  deps.ensure
    .mockRejectedValueOnce(new Error('invalid JSON'))
    .mockResolvedValueOnce([{ role: 'reviewer', status: 'started' }])
  await startProjectTeams()
  expect(deps.ensure).toHaveBeenCalledTimes(2)
  expect(deps.ensure.mock.calls[1][0]).toMatchObject({ projectRoot: '/local/folder' })
  const report = JSON.parse(await readFile(join(deps.profile, 'project-team-runtime.json'), 'utf8'))
  expect(report.teams[0]).toMatchObject({ code: 'team_config_load_failed', roles: [] })
  expect(report.teams[1].roles).toEqual([{ role: 'reviewer', status: 'started' }])
})
