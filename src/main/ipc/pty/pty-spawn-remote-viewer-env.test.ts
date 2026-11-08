import { describe, expect, it, vi } from 'vitest'
import { PI_CLIPBOARD_OSC52_ENV } from './host-env/remote-viewer-clipboard-env'
import { REMOTE_VIEWER_CLIPBOARD_ENV } from '../../../shared/remote-viewer-clipboard-env'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './register-handlers'

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
vi.mock('../../pty/shell-startup/pwsh', () =>
  import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../wsl/filesystem/unc-path-access', async (importOriginal) =>
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
vi.mock('../../codex/configuration/homes/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/history/index/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

const PAIRED_WORKTREE = 'wt-paired'
const PAIRED_TAB = 'tab-paired'
const LEAF = '33333333-3333-4333-8333-333333333333'

function runtimeHoldingPairedCreate(): OrcaRuntimeService {
  return {
    setPtyController: vi.fn(),
    preAllocateHandleForPty: vi.fn(),
    onPtySpawned: vi.fn(),
    registerPty: vi.fn(),
    pendingRemoteViewerCreateEnv: (worktreeId: string, tabId: string) =>
      worktreeId === PAIRED_WORKTREE && tabId === PAIRED_TAB
        ? { [REMOTE_VIEWER_CLIPBOARD_ENV]: '1', [PI_CLIPBOARD_OSC52_ENV]: '1' }
        : undefined
  } as unknown as OrcaRuntimeService
}

describe('a window pane spawn for a tab a paired viewer created', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  async function spawnPaneEnv(tabId: string): Promise<Record<string, string>> {
    handlers.clear()
    registerPtyHandlers(mainWindow, runtimeHoldingPairedCreate())
    spawnMock.mockClear()
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      worktreeId: PAIRED_WORKTREE,
      tabId,
      leafId: LEAF
    })
    return spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
  }

  it('carries the create viewer clipboard env into the pane shell', async () => {
    const env = await spawnPaneEnv(PAIRED_TAB)
    expect(env[REMOTE_VIEWER_CLIPBOARD_ENV]).toBe('1')
    expect(env[PI_CLIPBOARD_OSC52_ENV]).toBe('1')
  })

  it('leaves an unrelated tab without the marker', async () => {
    const env = await spawnPaneEnv('tab-local')
    expect(env[REMOTE_VIEWER_CLIPBOARD_ENV]).toBeUndefined()
  })
})
