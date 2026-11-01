import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'

import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './register-handlers'

type DirectoryStats = { isDirectory(): boolean }

const statMock = vi.hoisted(() => vi.fn<(path: string) => Promise<DirectoryStats>>())

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))
vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

const WORKTREE = '/Volumes/nas/repo'
const directoryStats = { isDirectory: () => true }

function spawnWithWorktreeFallback(cwd: string): Promise<unknown> {
  return Promise.resolve(
    handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd,
      cwdFallback: 'worktree',
      worktreeId: `repo-1::${WORKTREE}`
    })
  )
}

const { handlers, mainWindow } = setupPtyIpcSuite()

beforeEach(() => {
  statMock.mockReset()
  // Provider validation uses sync stat; folder-workspace validation uses async stat.
  statMock.mockImplementation(async () => directoryStats)
})

describe('pty:spawn with the worktree-folder fallback on a mount that stopped answering', () => {
  it('never asks the worktree folder once the saved folder answers', async () => {
    const outsideCwd = '/Users/alice/scratch'
    statMock.mockImplementation(async (path) =>
      path === outsideCwd ? directoryStats : new Promise<DirectoryStats>(() => {})
    )
    registerPtyHandlers(mainWindow as never)

    await spawnWithWorktreeFallback(outsideCwd)

    expect(statMock.mock.calls.map(([path]) => path)).toEqual([outsideCwd])
    const [, , options] = spawnMock.mock.calls.at(-1) as [string, string[], { cwd: string }]
    expect(options.cwd).toBe(outsideCwd)
  })
})
