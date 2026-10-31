// A headless server has no window store to stamp Recent, so the host stamps terminal starts and exits itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'
import { partialRuntimeStore, storeRepo, storeWorktreeMeta } from './runtime-store-partial-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WT = 'repo-1::/tmp/wt-a'
const PTY = `${WT}@@a1b2c3d4`

function createRuntime(window: 'headless' | 'desktop') {
  const meta: Record<string, WorktreeMeta> = { [WT]: storeWorktreeMeta({ lastActivityAt: 1 }) }
  const repo = storeRepo({ id: 'repo-1', path: '/tmp/repo-1', connectionId: null })
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getRepos: () => [repo],
      getRepo: (id) => (id === repo.id ? repo : undefined),
      getWorktreeMeta: (id) => meta[id],
      getAllWorktreeMeta: () => meta,
      setWorktreeMeta: ({ id }: HostWorktreeTarget, updates) => {
        meta[id] = { ...meta[id], ...updates }
        return meta[id]
      }
    })
  )
  // SAFETY: test-only stub of the protected selector resolver; no git checkout exists here.
  vi.spyOn(
    runtime as unknown as { resolveTerminalWorkspaceLaunchScope: () => Promise<unknown> },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: WT,
    path: '/tmp/wt-a',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  if (window === 'headless') {
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  } else {
    runtime.attachWindow(1)
  }
  return { runtime, meta }
}

describe('workspace activity without a desktop window', () => {
  beforeEach(() => vi.useFakeTimers({ now: 50_000, toFake: ['Date'] }))
  afterEach(() => vi.useRealTimers())

  it('stamps lastActivityAt when a terminal starts and when it exits', async () => {
    const { runtime, meta } = createRuntime('headless')

    await runtime.createTerminal(`id:${WT}`, {})
    expect(meta[WT].lastActivityAt).toBe(50_000)

    vi.setSystemTime(90_000)
    await runtime.onPtyExit(PTY, 0)
    expect(meta[WT].lastActivityAt).toBe(90_000)
  })

  it('leaves lastActivityAt to the window store when a desktop window is attached', async () => {
    const { runtime, meta } = createRuntime('desktop')

    await runtime.createTerminal(`id:${WT}`, {})
    await runtime.onPtyExit(PTY, 0)
    expect(meta[WT].lastActivityAt).toBe(1)
  })

  function agentPane(runtime: OrcaRuntimeService) {
    const server = new AgentHookServer()
    runtime.attachAgentStatusStore(server)
    return (state: 'working' | 'done') =>
      server.ingestTerminalStatus({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        tabId: 'tab-1',
        worktreeId: WT,
        payload: { state, prompt: 'task', agentType: 'claude' }
      })
  }

  it('stamps lastActivityAt on agent turns, at most once per throttle window', () => {
    const { runtime, meta } = createRuntime('headless')
    const report = agentPane(runtime)

    report('working')
    expect(meta[WT].lastActivityAt).toBe(50_000)

    vi.setSystemTime(55_000)
    report('done')
    expect(meta[WT].lastActivityAt).toBe(50_000)

    vi.setSystemTime(70_000)
    report('working')
    expect(meta[WT].lastActivityAt).toBe(70_000)
  })

  it('leaves agent turns to the window store when a desktop window is attached', () => {
    const { runtime, meta } = createRuntime('desktop')
    agentPane(runtime)('working')
    expect(meta[WT].lastActivityAt).toBe(1)
  })
})
