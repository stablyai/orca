import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  _resetClosedPaneFencesForTests,
  fencedIfLayoutOwner,
  partitionsFence
} from '../../persistence/terminal-topology/closed-pane-binding-fence'
import { Store } from '../../persistence/loading-store/store'
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
vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const TAB = 'tab-1'
const KEPT = '11111111-1111-4111-8111-111111111111'
const TAKEN = '22222222-2222-4222-8222-222222222222'

function sessionWith(leafIds: string[]): WorkspaceSessionState {
  const [first, second] = leafIds
  return {
    ...getDefaultWorkspaceSession(),
    terminalLayoutsByTabId: {
      [TAB]: {
        root: second
          ? {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: first! },
              second: { type: 'leaf', leafId: second }
            }
          : { type: 'leaf', leafId: first! },
        activeLeafId: first!,
        expandedLeafId: null
      }
    }
  }
}

describe('a window spawn for a pane main took back while it waited', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  afterEach(() => _resetClosedPaneFencesForTests())

  it('is refused before the provider spawns anything', async () => {
    const current = { value: sessionWith([KEPT, TAKEN]) }
    fencedIfLayoutOwner(
      () => partitionsFence(['local'], () => current.value, true),
      () => ((current.value = sessionWith([KEPT])), { value: null })
    )()
    const store: Store = Object.create(Store.prototype)
    vi.spyOn(store, 'getWorkspaceSessionHostIds').mockReturnValue([LOCAL_EXECUTION_HOST_ID])
    vi.spyOn(store, 'getWorkspaceSession').mockImplementation(() => current.value)
    handlers.clear()
    registerPtyHandlers(mainWindow, undefined, undefined, undefined, undefined, store)
    spawnMock.mockClear()

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        command: 'touch ran',
        tabId: TAB,
        leafId: TAKEN
      })
    ).rejects.toThrow('terminal_pane_closed')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(current.value.terminalLayoutsByTabId?.[TAB]?.root).toEqual({
      type: 'leaf',
      leafId: KEPT
    })
  })
})
