import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  holdWslMoveWindowWrites,
  reloadWslMoveWindowWithWritesHeld,
  resetWslMoveWindowWriteHoldForTests
} from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'
import { registerWslMoveWiring } from './wsl-move-driver-wiring'

vi.mock('electron', () => ({
  app: { getPath: () => '/user-data', getVersion: () => '1.0.0' },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }
}))
const contents = vi.hoisted(() => ({
  isDestroyed: () => false,
  reload: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('./ui', () => ({
  getTrustedUIRendererWebContents: () => contents,
  getTrustedUIRendererWindow: () => null
}))
vi.mock('./wsl-move-handlers', () => ({ registerWslMoveHandlers: vi.fn() }))
vi.mock('./wsl-move-orchestrator-wiring', () => ({ registerWslMoveOrchestrator: vi.fn() }))

afterEach(() => {
  resetWslMoveWindowWriteHoldForTests()
})

describe('WSL move wiring: reload landing', () => {
  it("moves a saved Settings view to the workspace view when a move's reload is owed", async () => {
    const ui = { activeView: 'settings' }
    const store = {
      getUI: () => ui,
      updateUI: (patch: { activeView?: string }) => Object.assign(ui, patch)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wiring touches only getUI/updateUI here; handler registration is mocked.
    registerWslMoveWiring(store as unknown as Store, {} as OrcaRuntimeService)

    holdWslMoveWindowWrites()
    reloadWslMoveWindowWithWritesHeld()
    await new Promise((resolve) => setImmediate(resolve))

    expect(ui.activeView).toBe('terminal')
    expect(contents.reload).toHaveBeenCalledOnce()
  })
})
