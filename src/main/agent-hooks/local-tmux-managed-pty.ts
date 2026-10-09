import type { PtyProcessInfo } from '../providers/types'
import type { TmuxManagedPty } from '../../shared/tmux-agent-hook-owner'

/** Reuse the daemon's authenticated inventory; never resolve an SSH pane from the client. */
export function createLocalTmuxManagedPtyResolver(options: {
  getPtyId: (paneKey: string) => string | undefined | null
  listProcesses: () => Promise<PtyProcessInfo[]>
}): (paneKey: string) => Promise<TmuxManagedPty | null> {
  let pending: Promise<PtyProcessInfo[]> | undefined
  let inventory: PtyProcessInfo[] = []
  let capturedAt = -Infinity
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
  return async (paneKey) => {
    if (process.platform === 'win32') {
      return null
    }
    const id = options.getPtyId(paneKey)
    if (!id) {
      return null
    }
    const row = (await read()).find((entry) => entry.id === id)
    if (!row?.rootProcessId || !row.incarnationId || !row.worktreeId || row.wslDistro) {
      return null
    }
    if (options.getPtyId(paneKey) !== id) {
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
