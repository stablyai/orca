import { beforeEach, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import type { Repo } from '../../shared/repo-types'
import type * as PrecheckRunner from './precheck-runner'
import type { Store } from '../persistence/loading-store/store'

const { runPrecheck, scan, query } = vi.hoisted(() => ({
  runPrecheck: vi.fn(),
  scan: vi.fn(),
  query: vi.fn()
}))
vi.mock('../providers/execution-host-provider-dispatch', () => ({
  resolveGitRouteForHost: () => ({ kind: 'local', createProvider: () => ({ exec: query }) })
}))
vi.mock('./precheck-runner', async (original) => ({
  ...(await original<typeof PrecheckRunner>()),
  runAutomationPrecheck: runPrecheck
}))
vi.mock('../ipc/worktrees/listing/detected-worktree-scan-cache', () => ({
  readFreshDetectedGitWorktrees: scan
}))
vi.mock('../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
const { runAutomationRequestPrecheck } = await import('./automation-dispatch-request')
const repo: Repo = {
  id: 'r',
  path: '/project',
  displayName: 'Project',
  badgeColor: 'blue',
  addedAt: 1
}
const storeFor = (entry: Automation) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: precheck only reads these members and passes the store to mocked option readers.
  return {
    listAutomations: () => [entry],
    listAutomationRuns: () => [{ id: 'run', trigger: 'scheduled' }]
  } as Store
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this entry point reads only these automation fields.
const automation = {
  id: 'automation',
  workspaceMode: 'existing',
  workspaceId: 'r::/project/.bare',
  executionTargetType: 'local',
  executionTargetId: 'local',
  precheck: { command: 'pwd', timeoutSeconds: 30 }
} as Automation

beforeEach(() => {
  vi.clearAllMocks()
  query.mockResolvedValue({ stdout: 'true' })
  scan.mockReturnValue([
    { path: '/project/.bare', head: '', branch: '', isBare: true, isMainWorktree: true },
    { path: '/project/main', head: 'abc', branch: '', isBare: false, isMainWorktree: false }
  ])
})

it('refuses an existing bare workspace before its command can run', async () => {
  const result = await runAutomationRequestPrecheck(
    storeFor(automation),
    'automation',
    'run',
    () => ({ ok: true, repo, cwd: '/project' })
  )
  expect(result).toMatchObject({ exitCode: null })
  expect(runPrecheck).not.toHaveBeenCalled()
})

it('runs an existing checkout precheck inside its checked-out files', async () => {
  const entry = { ...automation, workspaceId: 'r::/project/main' }
  await runAutomationRequestPrecheck(storeFor(entry), 'automation', 'run', () => ({
    ok: true,
    repo,
    cwd: '/project'
  }))
  expect(runPrecheck).toHaveBeenCalledWith({
    precheck: { command: 'pwd', timeoutSeconds: 30 },
    target: { type: 'local', cwd: '/project/main' }
  })
})
