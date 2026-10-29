import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { OrcadTerminalRestoreHintStore } from '../persistence/migrating-orcad-catalog/orcad-terminal-restore-hint-store'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE = `${TAB_ID}:${LEAF_ID}`
const WORKTREE_ID = 'wt-1'
const MIGRATION = { migrationKey: 'a'.repeat(32), migrationId: 'migration-1' }

let dir: string
let worktreePath: string
let hinted: string

class MigratedPaneRuntime extends OrcaRuntimeService {
  constructor(
    store: RuntimeStore,
    private readonly connectionId: string | null
  ) {
    super(store)
  }

  override async resolveTerminalWorkspaceLaunchScope(): Promise<TerminalWorkspaceLaunchScope> {
    return {
      id: WORKTREE_ID,
      path: worktreePath,
      connectionId: this.connectionId,
      repo: null,
      folderWorkspace: null
    }
  }
}

type Hint = { paneKey: string; cwd: string; worktreeId?: string }

function runtimeWithHints(
  hints: Hint[],
  options: {
    connectionId?: string | null
    spawn?: RuntimePtyController['spawn']
    claimStablePaneCreate?: RuntimePtyController['claimStablePaneCreate']
    onPeek?: () => void
  } = {}
): {
  runtime: MigratedPaneRuntime
  spawn: ReturnType<typeof vi.fn>
  hintStore: OrcadTerminalRestoreHintStore
} {
  const hintStore = new OrcadTerminalRestoreHintStore(join(dir, 'blobs'))
  hintStore.install(
    MIGRATION,
    hints.map((hint) => ({
      ...hint,
      worktreeId: hint.worktreeId ?? WORKTREE_ID
    })),
    Date.now()
  )
  const store: RuntimeStore = {
    getRepos: () => [],
    getRepo: () => undefined,
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
    removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getSettings: () => ({
      workspaceDir: '/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    peekOrcadMigrationTerminalRestoreHint: (paneKey, worktreeId) => {
      options.onPeek?.()
      return hintStore.peek(paneKey, worktreeId, Date.now())
    },
    consumeOrcadMigrationTerminalRestoreHint: (paneKey) => hintStore.consume(paneKey, Date.now())
  }
  const runtime = new MigratedPaneRuntime(store, options.connectionId ?? null)
  const spawn = vi.fn(options.spawn ?? (async () => ({ id: `pty-${spawn.mock.calls.length}` })))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    ...(options.claimStablePaneCreate
      ? { claimStablePaneCreate: options.claimStablePaneCreate }
      : {})
  })
  return { runtime, spawn, hintStore }
}

function spawnedCwd(spawn: ReturnType<typeof vi.fn>, call: number): unknown {
  const args: unknown = spawn.mock.calls[call]?.[0]
  return typeof args === 'object' && args !== null && 'cwd' in args ? args.cwd : undefined
}

function remainingHint(hintStore: OrcadTerminalRestoreHintStore, paneKey = PANE): string | null {
  return hintStore.peek(paneKey, WORKTREE_ID, Date.now())
}

describe('migrated pane restore cwd at terminal create', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-migrated-pane-cwd-'))
    worktreePath = join(dir, 'repo')
    hinted = join(worktreePath, 'packages', 'web')
    mkdirSync(hinted, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens a default-cwd create in the hinted folder once, then at the worktree root', async () => {
    const { runtime, spawn, hintStore } = runtimeWithHints([{ paneKey: PANE, cwd: hinted }])

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })
    expect(remainingHint(hintStore)).toBeNull()
    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })

    expect(spawnedCwd(spawn, 0)).toBe(hinted)
    expect(spawnedCwd(spawn, 1)).toBe(worktreePath)
  })

  it('keeps the hint when the create fails, so the retry still opens in the hinted folder', async () => {
    let attempts = 0
    const { runtime, spawn, hintStore } = runtimeWithHints([{ paneKey: PANE, cwd: hinted }], {
      spawn: async () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('spawn_failed')
        }
        return { id: 'pty-retry' }
      }
    })

    await expect(
      runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })
    ).rejects.toThrow('spawn_failed')
    expect(remainingHint(hintStore)).toBe(hinted)

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })
    expect(spawnedCwd(spawn, 1)).toBe(hinted)
    expect(remainingHint(hintStore)).toBeNull()
  })

  it('opens an explicit cwd and spends the hint: that create was the restore', async () => {
    const { runtime, spawn, hintStore } = runtimeWithHints([{ paneKey: PANE, cwd: hinted }])

    await runtime.createTerminal('id:wt-1', {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      cwd: dir
    })
    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })

    expect(spawnedCwd(spawn, 0)).toBe(dir)
    expect(spawnedCwd(spawn, 1)).toBe(worktreePath)
    expect(remainingHint(hintStore)).toBeNull()
  })

  it('never applies a hint installed for another worktree', async () => {
    const { runtime, spawn } = runtimeWithHints([
      { paneKey: PANE, cwd: hinted, worktreeId: 'wt-other' }
    ])

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })

    expect(spawnedCwd(spawn, 0)).toBe(worktreePath)
  })

  it('falls back to the worktree root when the folder is gone, and spends the hint', async () => {
    const { runtime, spawn, hintStore } = runtimeWithHints([
      { paneKey: PANE, cwd: join(worktreePath, 'deleted') }
    ])

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })

    expect(spawnedCwd(spawn, 0)).toBe(worktreePath)
    expect(hintStore.peek(PANE, WORKTREE_ID, Date.now())).toBeNull()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'falls back to the worktree root for a folder the shell cannot search',
    async () => {
      chmodSync(hinted, 0o600)
      try {
        const { runtime, spawn } = runtimeWithHints([{ paneKey: PANE, cwd: hinted }])

        await runtime.createTerminal('id:wt-1', {
          tabId: TAB_ID,
          leafId: LEAF_ID
        })

        expect(spawnedCwd(spawn, 0)).toBe(worktreePath)
      } finally {
        chmodSync(hinted, 0o700)
      }
    }
  )

  it('claims the pane before reading its hint', async () => {
    const order: string[] = []
    const { runtime } = runtimeWithHints([{ paneKey: PANE, cwd: hinted }], {
      claimStablePaneCreate: () => {
        order.push('claim')
        return () => order.push('release')
      },
      onPeek: () => order.push('peek')
    })

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })

    expect(order.slice(0, 2)).toEqual(['claim', 'peek'])
  })

  it("never applies another pane's hint", async () => {
    const otherPane = `${TAB_ID}:${OTHER_LEAF_ID}`
    const { runtime, spawn, hintStore } = runtimeWithHints([{ paneKey: otherPane, cwd: hinted }])

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })
    await runtime.createTerminal('id:wt-1', {})

    expect(spawnedCwd(spawn, 0)).toBe(worktreePath)
    expect(spawnedCwd(spawn, 1)).toBe(worktreePath)
    expect(remainingHint(hintStore, otherPane)).toBe(hinted)
  })

  it('ignores hints for an SSH workspace, whose folders this host cannot check', async () => {
    const { runtime, spawn } = runtimeWithHints([{ paneKey: PANE, cwd: hinted }], {
      connectionId: 'ssh-1'
    })

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })

    expect(spawnedCwd(spawn, 0)).toBe(worktreePath)
  })
})
