import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn(() => true) },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

const getSshGitProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: vi.fn(() => 0),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable',
  requireSshGitProvider: (connectionId: string) => getSshGitProviderMock(connectionId)
}))

import { OrcaRuntimeService } from './orca-runtime'

// BUG-9: a network drop to a relay host made `worktree ps` print `live:0 pty:no` for a terminal
// that was still running. Lost contact is `unverifiable`, never zero.

const CONNECTION_ID = 'conn-1'
const REPO_PATH = '/home/user/app'
const WORKTREE_ID = `repo-ssh::${REPO_PATH}`
const PTY_ID = `ssh:${CONNECTION_ID}@@relay-1`

const REPO = {
  id: 'repo-ssh',
  path: REPO_PATH,
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 0,
  connectionId: CONNECTION_ID
}

function makeStore() {
  const session = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [REPO]),
    getRepo: vi.fn((id: string) => (id === REPO.id ? REPO : undefined)),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getAllWorktreeLineage: vi.fn(() => ({})),
    getAllWorkspaceLineage: vi.fn(() => ({})),
    getGitHubCache: vi.fn(() => undefined),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function makeRuntime(controller: {
  hasPty: () => boolean | null
  listProcesses: () => Promise<{ id: string; worktreeId: string }[]>
}): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only the store methods this fixture defines.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.ps reaches only listProcesses and hasPty on this controller.
    {
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      ...controller
    } as never
  )
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  runtime.registerPty(PTY_ID, WORKTREE_ID, CONNECTION_ID)
  return runtime
}

async function psRow(runtime: OrcaRuntimeService) {
  const result = await runtime.getWorktreePs(100)
  return result.worktrees.find((row) => row.worktreeId === WORKTREE_ID)
}

describe('worktree.ps terminal verdicts for an SSH host', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn(async () => [
        { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
      ])
    })
  })

  it('counts a terminal the reachable host lists as live', async () => {
    const runtime = makeRuntime({
      hasPty: () => true,
      listProcesses: async () => [{ id: PTY_ID, worktreeId: WORKTREE_ID }]
    })

    const row = await psRow(runtime)

    expect(row).toMatchObject({ liveTerminalCount: 1, hasAttachedPty: true })
    expect(row?.unverifiableTerminalCount).toBe(0)
  })

  it('reports a terminal on an unreachable host as unverifiable, not zero', async () => {
    const runtime = makeRuntime({
      hasPty: () => null,
      listProcesses: async () => {
        throw new Error('relay connection lost')
      }
    })
    // The relay drop reports every PTY of the host with an unconfirmed exit.
    runtime.onPtyExit(PTY_ID, -1)

    const row = await psRow(runtime)

    expect(row).toMatchObject({
      liveTerminalCount: 0,
      hasAttachedPty: false,
      unverifiableTerminalCount: 1
    })
  })

  it('reports nothing for a terminal whose host confirmed the exit', async () => {
    const runtime = makeRuntime({ hasPty: () => false, listProcesses: async () => [] })
    runtime.onPtyExit(PTY_ID, -1, undefined, { hostExitConfirmed: true })

    const row = await psRow(runtime)

    expect(row).toMatchObject({ liveTerminalCount: 0, hasAttachedPty: false })
    expect(row?.unverifiableTerminalCount).toBe(0)
  })

  it('returns to live once the reconnected host lists the terminal again', async () => {
    let reachable = false
    const runtime = makeRuntime({
      hasPty: () => (reachable ? true : null),
      listProcesses: async () => (reachable ? [{ id: PTY_ID, worktreeId: WORKTREE_ID }] : [])
    })
    runtime.onPtyExit(PTY_ID, -1)
    expect((await psRow(runtime))?.unverifiableTerminalCount).toBe(1)

    reachable = true
    const row = await psRow(runtime)

    expect(row).toMatchObject({ liveTerminalCount: 1, hasAttachedPty: true })
    expect(row?.unverifiableTerminalCount).toBe(0)
  })
})
