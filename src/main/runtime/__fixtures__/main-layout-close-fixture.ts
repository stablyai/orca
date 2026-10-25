// Switch-on stand-ins for close fixtures: main's `layout.apply` over a fake store's one session,
// and what the desktop sees of a CLI pane close that main's layout carries.
import { expect, type Mock } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import type {
  LayoutApplyOutcome,
  LayoutCommand
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { DurableProfileStateMutation } from '../../persistence/loading-store/store-runtime-state'
import { resolveHostId } from '../../persistence/loading-store/session-host-partitions'
import { applyCommandToSession } from '../../persistence/terminal-topology/terminal-pane-admission'
import {
  isTerminalClose,
  keptOnWriteFailure
} from '../../persistence/terminal-topology/terminal-close-write-failure'

type SessionCell = {
  get: () => WorkspaceSessionState
  set: (session: WorkspaceSessionState) => void
}

/** Main's `layout.apply` on the session, applied at once. */
export function sessionLayoutApply(cell: SessionCell) {
  return async (command: LayoutCommand, hostIds: readonly string[] = []) => {
    const change = applyCommandToSession(resolveHostId(hostIds[0]), cell.get(), command)
    if (change.session) {
      cell.set(change.session)
    }
    return change.value
  }
}

/** As the Store runs `layout.apply`: one durable write, and a close stands though it fails. */
export function durableSessionLayoutApply(
  store: {
    runDurableMutation: <V>(mutate: () => DurableProfileStateMutation<V>) => Promise<V>
  },
  cell: SessionCell
) {
  return (command: LayoutCommand, hostIds: readonly string[] = []) => {
    const mutate = (): DurableProfileStateMutation<LayoutApplyOutcome> => {
      const before = cell.get()
      const change = applyCommandToSession(resolveHostId(hostIds[0]), before, command)
      if (change.session) {
        cell.set(change.session)
      }
      return { value: change.value, rollback: () => cell.set(before) }
    }
    return isTerminalClose(command)
      ? keptOnWriteFailure(
          (run) => store.runDurableMutation(run),
          mutate,
          () => {}
        )
      : store.runDurableMutation(mutate)
  }
}

/** A fake store as a profile's: its host list, and the Store's durable `layout.apply`. */
export function withMainLayout<
  T extends { runDurableMutation: <V>(mutate: () => DurableProfileStateMutation<V>) => Promise<V> }
>(store: T, cell: SessionCell) {
  return Object.assign(store, {
    getWorkspaceSessionHostIds: () => ['local'],
    applyLayoutCommand: durableSessionLayoutApply(store, cell)
  })
}

/**
 * The desktop drops a pane a CLI close by handle ended. Switch-off the window is told to; switch-on
 * main's layout close carries it, so the window-era notice goes out only for a pane main had
 * already dropped, and never twice.
 */
export function expectDesktopDropsPane(
  harness: {
    closeTerminalPane: Mock<(...args: unknown[]) => unknown>
    getSession: () => WorkspaceSessionState
  },
  tabId: string,
  leafId: string
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    expect(harness.closeTerminalPane).toHaveBeenCalledExactlyOnceWith(tabId, leafId)
    return
  }
  expect(collectLeafIds(harness.getSession().terminalLayoutsByTabId[tabId]?.root)).not.toContain(
    leafId
  )
  expect(harness.closeTerminalPane.mock.calls.length).toBeLessThanOrEqual(1)
  for (const call of harness.closeTerminalPane.mock.calls) {
    expect(call).toEqual([tabId, leafId])
  }
}

/**
 * The desktop drops a tab a phone or CLI closed. Switch-off the window is told to close it;
 * switch-on main closes it in its own layout (#31571) and the window draws that, unasked.
 */
export function expectDesktopDropsTab(
  harness: {
    closeTerminal: Mock<(...args: unknown[]) => unknown>
    getSession: () => WorkspaceSessionState
  },
  tabId: string
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    expect(harness.closeTerminal).toHaveBeenCalledWith(tabId)
    return
  }
  expect(harness.getSession().terminalLayoutsByTabId[tabId]).toBeUndefined()
  expect(
    Object.values(harness.getSession().tabsByWorktree)
      .flat()
      .map((tab) => tab.id)
  ).not.toContain(tabId)
  expect(harness.closeTerminal).not.toHaveBeenCalled()
}
