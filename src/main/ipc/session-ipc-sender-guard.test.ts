import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))

import { registerSessionHandlers } from './session'

describe('session-ipc-sender-guard (INV-4: STRIDE)', () => {
  let mockStore: Store
  let mockRuntime: OrcaRuntimeService
  let storeState: Record<string, unknown>
  const satelliteSender = { id: 99 }
  const mainSender = { id: 1 }

  beforeEach(() => {
    handlers.clear()
    storeState = {
      activeWorktreeId: 'initial',
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }

    mockStore = {
      getWorkspaceSession: vi.fn(() => storeState as unknown as WorkspaceSessionState),
      setWorkspaceSession: vi.fn((session: WorkspaceSessionState) => {
        storeState = session as unknown as Record<string, unknown>
      }),
      patchWorkspaceSession: vi.fn((patch: WorkspaceSessionPatch) => {
        storeState = { ...storeState, ...patch }
      }),
      getWorkspaceSessionHostIds: vi.fn(() => [])
    } as unknown as Store

    mockRuntime = {
      shutdownReconnectFactsFor: vi.fn(() => ({})),
      closeTerminalSurfaceFromRenderer: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService

    const isWorkspacePopoutRenderer = (sender: unknown) => sender === satelliteSender

    registerSessionHandlers(mockStore, mockRuntime, {
      isWorkspacePopoutRenderer: isWorkspacePopoutRenderer as never
    })
  })

  it('silently discards session:set from satellite sender without mutating store', async () => {
    const handler = handlers.get('session:set')!
    expect(handler).toBeDefined()

    const maliciousState = {
      activeWorktreeId: 'hacked',
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    } as unknown as WorkspaceSessionState

    const result = await handler({ sender: satelliteSender }, maliciousState, 'local')
    expect(result).toBeUndefined()

    expect(mockStore.setWorkspaceSession).not.toHaveBeenCalled()
    expect(storeState.activeWorktreeId).toBe('initial')
  })

  it('silently discards session:patch from satellite sender without mutating store', async () => {
    const handler = handlers.get('session:patch')!
    expect(handler).toBeDefined()

    const maliciousPatch = {
      activeWorktreeId: 'hacked-patch'
    } as unknown as WorkspaceSessionPatch

    const result = await handler({ sender: satelliteSender }, maliciousPatch, 'local')
    expect(result).toBeUndefined()

    expect(mockStore.patchWorkspaceSession).not.toHaveBeenCalled()
    expect(storeState.activeWorktreeId).toBe('initial')
  })

  it('silently discards session:close-terminal-surface from satellite sender without calling runtime', async () => {
    const handler = handlers.get('session:close-terminal-surface')!
    expect(handler).toBeDefined()

    const closeArgs = {
      worktreeId: 'wt-1',
      target: { tabId: 'tab-1' },
      reason: 'user'
    }

    const result = await handler({ sender: satelliteSender }, closeArgs)
    expect(result).toBeNull()
    expect(mockRuntime.closeTerminalSurfaceFromRenderer).not.toHaveBeenCalled()
  })

  it('permits session:set and session:patch from main sender', async () => {
    const setHandler = handlers.get('session:set')!
    const newState = {
      activeWorktreeId: 'legit-main',
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    } as unknown as WorkspaceSessionState

    await setHandler({ sender: mainSender }, newState, 'local')
    expect(mockStore.setWorkspaceSession).toHaveBeenCalled()

    const patchHandler = handlers.get('session:patch')!
    await patchHandler({ sender: mainSender }, { activeWorktreeId: 'patched-main' }, 'local')
    expect(mockStore.patchWorkspaceSession).toHaveBeenCalled()
  })
})
