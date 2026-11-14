import type { PtyProcessInfo } from '../../providers/pty/process-info'
import type { TmuxManagedPty } from '../../../shared/tmux-agent-hook-contract'
import type { HookPaneProcessIo } from '../../../shared/agent-hook-listener/presence/hook-process-root-evidence'

type InventoryOptions = {
  getPtyId: (paneKey: string) => string | undefined | null
  listProcesses: () => Promise<PtyProcessInfo[]>
}

/** A pane's row in the owning provider's authenticated inventory, re-checked after the read. */
export type LocalPtyInventoryReader = (
  paneKey: string,
  options?: { bySpawnPaneKey?: boolean }
) => Promise<PtyProcessInfo | null>

/** Reuse the daemon's authenticated inventory; never resolve an SSH pane from the client. */
export function createLocalPtyInventoryReader(options: InventoryOptions): LocalPtyInventoryReader {
  let pending: Promise<PtyProcessInfo[]> | undefined
  let inventory: PtyProcessInfo[] = []
  let capturedAt = -Infinity
  // The snapshot a miss already forced; a pane still missing from it waits for the next one.
  let forcedAt = -Infinity
  const read = async (): Promise<PtyProcessInfo[]> => {
    if (Date.now() - capturedAt < 1000) {
      return inventory
    }
    if (!pending) {
      pending = options
        .listProcesses()
        .then((rows) => {
          inventory = rows
          capturedAt = Date.now()
          return rows
        })
        .finally(() => {
          pending = undefined
        })
    }
    return pending
  }
  const find = (rows: PtyProcessInfo[], paneKey: string, id: string | undefined | null) => {
    // Before a restored pane reattaches, the provider's own spawn record still names its PTY.
    const spawned = id ? [] : rows.filter((entry) => entry.paneKey === paneKey)
    return (id ? rows.find((entry) => entry.id === id) : spawned.length === 1 && spawned[0]) || null
  }
  return async (paneKey, lookup) => {
    const id = options.getPtyId(paneKey)
    if (!id && !lookup?.bySpawnPaneKey) {
      return null
    }
    const cachedAt = capturedAt
    let row = find(await read(), paneKey, id)
    // A snapshot taken before this PTY spawned (or reported its guest root) is no answer for it.
    if (
      (!row || (row.wslDistro && !row.wslGuestRoot)) &&
      cachedAt !== -Infinity &&
      cachedAt === capturedAt &&
      cachedAt !== forcedAt
    ) {
      capturedAt = -Infinity
      row = find(await read(), paneKey, id)
      forcedAt = capturedAt
    }
    return row && options.getPtyId(paneKey) === id ? row : null
  }
}

export function createLocalTmuxManagedPtyResolver(
  readInventory: LocalPtyInventoryReader
): (paneKey: string) => Promise<TmuxManagedPty | null> {
  return async (paneKey) => {
    if (process.platform === 'win32') {
      return null
    }
    const row = await readInventory(paneKey)
    if (!row?.rootProcessId || !row.incarnationId || !row.worktreeId || row.wslDistro) {
      return null
    }
    return {
      pid: row.rootProcessId,
      incarnation: row.incarnationId,
      scope: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: row.worktreeId,
        workspaceKind: row.worktreeId.startsWith('folder:') ? 'folder' : 'git-worktree'
      }
    }
  }
}

/** The root a hook must descend from to own a pane; a provider without root identity (an older
 *  daemon's retained PTY) keeps the legacy path. */
export function createLocalHookPaneRootResolver(
  readInventory: LocalPtyInventoryReader
): HookPaneProcessIo['resolveRoot'] {
  return async (paneKey, worktreeId) => {
    const row = await readInventory(paneKey, { bySpawnPaneKey: true }).catch(() => null)
    if (!row || row.wslDistro || (worktreeId && row.worktreeId && row.worktreeId !== worktreeId)) {
      return null
    }
    return row.rootProcessId && row.incarnationId
      ? { pid: row.rootProcessId, incarnation: row.incarnationId }
      : 'legacy'
  }
}

/** Binds a returned root to the relay link that asked; undefined once that link was replaced. */
export type RelayPaneRootIssuer = (
  paneKey: string,
  incarnation: string,
  isCurrent: () => boolean
) => string | undefined

/** What a WSL relay may anchor a pane to: the guest root its bridge PTY recorded at launch, under a
 *  binding the relay echoes on the owner it proves. A PTY from an owner that records none keeps the
 *  relay on its legacy path; nothing but a returned root binds. */
export function createWslBridgePaneRootReader(
  readInventory: LocalPtyInventoryReader,
  getPtyId: (paneKey: string) => string | undefined | null
): (
  issue: RelayPaneRootIssuer,
  distro: string,
  paneKey: string
) => Promise<Record<string, unknown>> {
  return async (issue, distro, paneKey) => {
    const row = await readInventory(paneKey, { bySpawnPaneKey: true }).catch(() => null)
    if (row?.wslDistro !== distro) {
      return {}
    }
    if (!row.wslGuestRoot || !row.incarnationId) {
      return { legacy: true }
    }
    const binding = issue(
      paneKey,
      row.incarnationId,
      () => (getPtyId(paneKey) ?? row.id) === row.id
    )
    return binding ? { root: row.wslGuestRoot, incarnation: binding } : {}
  }
}
