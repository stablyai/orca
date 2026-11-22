import { expect, it, vi } from 'vitest'
import { registerDesktopRelayHandlers } from './session-desktop-relays'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

// Perf contract: applying one host's relay ids (with each entries patch or full save) asks about that
// host only; it never lists every saved partition.

it('applies relay ids without listing saved partitions', () => {
  const hostIds = Array.from({ length: 40 }, (_, i) =>
    getRepoExecutionHostId({ connectionId: `box-${i}` })
  )
  const listHostIds = vi.fn((): ExecutionHostId[] => hostIds)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the applier reads only these store methods.
  const session = { tabsByWorktree: {}, desktopRelayAdoptionVersion: 1 } as WorkspaceSessionState
  const store = {
    getRepos: () => [],
    getWorkspaceSession: () => session,
    getWorkspaceSessionHostIds: listHostIds,
    hasWorkspaceSessionHost: () => true,
    patchWorkspaceSessionRelays: vi.fn()
  }
  const relayApplier = registerDesktopRelayHandlers(store, () => false)
  listHostIds.mockClear()

  for (const hostId of hostIds) {
    relayApplier([hostId])(hostId, { relayIdsByTabId: {}, complete: true }, session)
    relayApplier([hostId])(
      hostId,
      { relayIdsByTabId: {}, complete: false, removedTabIds: ['t'] },
      session
    )
  }

  expect(listHostIds).not.toHaveBeenCalled()
})
