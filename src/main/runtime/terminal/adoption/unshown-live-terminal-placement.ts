// Main places live local terminals absent from every pane at startup/window load, reusing their free recorded pane or creating a tab.

import { randomUUID } from 'node:crypto'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type {
  CommandOf,
  LayoutApplyReply
} from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { PtyPaneOf, PtyPaneSource } from '../surface/pty-pane-query'

type PlacementPty = PtyPaneSource &
  Pick<
    RuntimePtyWorktreeRecord,
    'incarnationId' | 'worktreeId' | 'connectionId' | 'runtimeSessionOwned' | 'connected'
  >

export type LiveTerminalPlacementPorts = {
  /** A fresh census of every local workspace; null when the host could not answer. */
  refreshInventory: () => Promise<{
    exitingPtyIds?: ReadonlySet<string>
    /** The workspaces this host knows: a terminal filed under any other id has no tab to join. */
    workspaceIds: ReadonlySet<string>
  } | null>
  ptys: () => Iterable<PlacementPty>
  /** A spawn still binding its pane (its workspace's spawn lock is held): not proven to have none. */
  isStillBinding: (pty: PlacementPty) => boolean
  paneOf: PtyPaneOf
  hostIds: () => readonly ExecutionHostId[]
  session: (hostId: ExecutionHostId) => WorkspaceSessionState | null | undefined
  apply: (command: CommandOf<'createTerminalTab'> & { tabId: string }) => Promise<LayoutApplyReply>
  /** Records the pane main showed the terminal in, so a census names it as the terminal's pane. */
  recordPane: (ptyId: string, paneKey: string) => void
}

export type LiveTerminalPlacement = { placed: string[]; declined: string[] }

function paneBoundPtyIds(ports: LiveTerminalPlacementPorts): Set<string> {
  const bound = new Set<string>()
  for (const hostId of ports.hostIds()) {
    const session = ports.session(hostId)
    for (const layout of Object.values(session?.terminalLayoutsByTabId ?? {})) {
      for (const ptyId of Object.values(layout.ptyIdsByLeafId ?? {})) {
        if (ptyId) {
          bound.add(ptyId)
        }
      }
    }
    for (const tabs of Object.values(session?.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        if (tab.ptyId) {
          bound.add(tab.ptyId)
        }
      }
    }
  }
  return bound
}

function recordedPaneKeyOf(
  ports: LiveTerminalPlacementPorts,
  pty: PlacementPty
): string | undefined {
  const { tabId, paneKey } = ports.paneOf(pty)
  const pane = parsePaneKey(paneKey ?? '')
  return pane && pane.tabId === tabId && paneKey ? paneKey : undefined
}

/** Require local, running, non-exiting inventory evidence; remote terminals are unverifiable here. */
function isUnshown(
  pty: PlacementPty,
  bound: ReadonlySet<string>,
  inventory: { exitingPtyIds?: ReadonlySet<string>; workspaceIds: ReadonlySet<string> }
): boolean {
  return (
    pty.connected &&
    inventory.workspaceIds.has(pty.worktreeId) &&
    pty.connectionId === null &&
    !pty.runtimeSessionOwned &&
    pty.worktreeId !== FLOATING_TERMINAL_WORKTREE_ID &&
    !bound.has(pty.ptyId) &&
    !inventory.exitingPtyIds?.has(pty.ptyId)
  )
}

/** Failed census places nothing; individual placement failures must not block other terminals or startup. */
export async function placeUnshownLiveTerminals(
  ports: LiveTerminalPlacementPorts
): Promise<LiveTerminalPlacement> {
  const placement: LiveTerminalPlacement = { placed: [], declined: [] }
  const failures: string[] = []
  const inventory = await ports.refreshInventory().catch((error: unknown) => {
    failures.push(`census: ${reasonOf(error)}`)
    return null
  })
  // An unanswered census proves nothing unshown.
  if (inventory) {
    // Snapshot records: inventory and concurrent spawns can change them across awaits.
    for (const pty of Array.from(ports.ptys())) {
      try {
        await placeOne(ports, pty, inventory, placement)
      } catch (error) {
        placement.declined.push(pty.ptyId)
        failures.push(`${pty.ptyId}: ${reasonOf(error)}`)
      }
    }
  }
  if (placement.declined.length > 0 || failures.length > 0) {
    console.warn('[layout] live terminals left without a pane', placement.declined, failures)
  }
  return placement
}

async function placeOne(
  ports: LiveTerminalPlacementPorts,
  pty: PlacementPty,
  inventory: Parameters<typeof isUnshown>[2],
  placement: LiveTerminalPlacement
): Promise<void> {
  // Re-read per terminal: an earlier placement bound panes, and a spawn may have bound since.
  if (!isUnshown(pty, paneBoundPtyIds(ports), inventory) || ports.isStillBinding(pty)) {
    return
  }
  const recordedPaneKey = recordedPaneKeyOf(ports, pty)
  const reply = await ports.apply({
    type: 'createTerminalTab',
    workspace: pty.worktreeId,
    tabId: randomUUID(),
    leafId: randomUUID(),
    adopt: {
      ptyId: pty.ptyId,
      ...(pty.incarnationId ? { incarnationId: pty.incarnationId } : {}),
      ...(recordedPaneKey ? { recordedPaneKey } : {})
    }
  })
  if (reply.ok) {
    // Binding completes placement; recording the pane is only a census convenience.
    placement.placed.push(pty.ptyId)
    if (reply.result.paneKey) {
      try {
        ports.recordPane(pty.ptyId, reply.result.paneKey)
      } catch (error) {
        console.warn('[layout] placed terminal kept its old pane record:', reasonOf(error))
      }
    }
  } else if (reply.code !== 'host_not_owned') {
    placement.declined.push(pty.ptyId)
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Placement failures must never block startup or client attachment. */
export async function placeUnshownLiveTerminalsBestEffort(
  runtime: { placeUnshownLiveTerminals?: () => Promise<unknown> } | null | undefined
): Promise<void> {
  try {
    await runtime?.placeUnshownLiveTerminals?.()
  } catch (error) {
    console.warn('[layout] showing live terminals failed:', reasonOf(error))
  }
}

export function exitingPtyIdsOf(sessions: readonly { id: string; exiting?: true }[]): Set<string> {
  return new Set(sessions.flatMap((session) => (session.exiting === true ? [session.id] : [])))
}
