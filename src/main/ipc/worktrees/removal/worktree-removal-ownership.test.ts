import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markAntigravityWorkspaceTrusted } from '../../../agent-launch/trust/agent-trust-presets'
import {
  removeDeletedCheckoutMetadataAndTransientState,
  removeWorktreeMetadataAndTransientState
} from './worktree-removal-ownership'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../../../codex/trust/project-trust/codex-project-trust-worker-spawn', async () => ({
  spawnCodexProjectTrustWorker: (
    await import('../../../codex/trust/project-trust/codex-project-trust-worker.test-fixture')
  ).codexProjectTrustTestWorker.factory
}))

const PROJECT = '/tmp/worktrees/sidebar-delete'
const WORKTREE_ID = `repo-1::${PROJECT}`

let userDataDir: string
let previousUserDataPath: string | undefined
let settingsPath: string

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-ipc-pretrust-removal-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  const agyHome = join(userDataDir, 'agy-home')
  settingsPath = join(agyHome, '.gemini', 'antigravity-cli', 'settings.json')
  mkdirSync(join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify({ trustedWorkspaces: ['/home/me/app'] }))
  markAntigravityWorkspaceTrusted(PROJECT, agyHome)
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
})

function purge(
  checkoutDeleted: boolean,
  repos: { id: string; connectionId?: string }[] = []
): Promise<void> {
  const store = {
    getWorktreeMeta: () => undefined,
    getRepos: () => repos,
    removeWorktreeMeta: () => {},
    getProfileStorageDirectory: () => userDataDir
  }
  const runtime = { releaseRemovedWorktreeHostSessions: () => {} }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the purge reads only the store members the fake supplies.
  const context = { store: store as never, runtime }
  return checkoutDeleted
    ? removeDeletedCheckoutMetadataAndTransientState(context, WORKTREE_ID, 'local')
    : removeWorktreeMetadataAndTransientState(context, WORKTREE_ID)
}

function trustedWorkspaces(): string[] {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')).trustedWorkspaces
}

it('drops the trust Orca wrote when a sidebar delete removes the checkout', async () => {
  await purge(true)

  expect(trustedWorkspaces()).toEqual(['/home/me/app'])
})

it('keeps the trust when the directory stays on disk (forget, folder removal)', async () => {
  await purge(false)

  expect(trustedWorkspaces()).toEqual(['/home/me/app', PROJECT])
})

it('still drops local trust when the same repo is also registered on another host', async () => {
  await purge(true, [{ id: 'repo-1' }, { id: 'repo-1', connectionId: 'ssh-box' }])

  expect(trustedWorkspaces()).toEqual(['/home/me/app'])
})
