/**
 * The production port of "Use on this computer again": the host's copies of the project's
 * terminals, reached over its paired runtime.
 */
import { z } from 'zod'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { WslMoveCutover } from '../../shared/wsl-move/wsl-move-cutover'
import type { Store } from '../persistence'
import { wslMoveDesktopRewriteContext } from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite'
import {
  stopWslMoveHostCopies,
  type WslMoveHostCopyStop
} from '../persistence/moving-wsl-projects/wsl-move-host-copy-stop'
import { wslMoveRewriteScope } from '../persistence/moving-wsl-projects/wsl-move-rewrite-scope'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import { getWslHostService } from '../wsl/wsl-host-service-instance'

export type WslMoveUndoPorts = {
  stopHostCopies: (move: WslMoveCutover) => Promise<WslMoveHostCopyStop>
}

// What undo reads of the host's terminal list: whether each terminal is still running.
const HostTerminalList = z.object({
  terminals: z.array(z.object({ connected: z.boolean() }).passthrough())
})

const SLEEP_TIMEOUT_MS = 60_000
const LIST_TIMEOUT_MS = 10_000

export function createWslMoveUndoPorts(store: Store, userDataPath: string): WslMoveUndoPorts {
  return {
    stopHostCopies: async (move) => {
      // A host the user removed ran its terminals down with it; nothing of the project runs there.
      if (!listEnvironments(userDataPath).some((env) => env.id === move.destinationEnvironmentId)) {
        return 'stopped'
      }
      const scope = wslMoveRewriteScope(wslMoveDesktopRewriteContext(userDataPath, move))
      const local = store.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID)
      const hostIds = [...new Set(Object.keys(local.tabsByWorktree).filter(scope.inScope))].map(
        (id) => scope.worktreeId(id)
      )
      // The user asked for this, so a host with no open work after a relaunch connects first.
      if (hostIds.length > 0) {
        try {
          await getWslHostService()?.ensureForUserRequest(move.destinationEnvironmentId)
        } catch (error) {
          console.warn('[wsl-move] The host did not connect for undo:', error)
          return 'unreachable'
        }
      }
      const call = async (method: string, params: unknown, timeoutMs: number) => {
        try {
          return await callRuntimeEnvironment(
            userDataPath,
            move.destinationEnvironmentId,
            method,
            params,
            timeoutMs
          )
        } catch {
          return null
        }
      }
      return stopWslMoveHostCopies(hostIds, {
        sleepWorkspace: async (id) => {
          const response = await call('worktree.sleep', { worktree: `id:${id}` }, SLEEP_TIMEOUT_MS)
          return response === null ? null : response.ok
        },
        liveTerminals: async (id) => {
          const response = await call('terminal.list', { worktree: `id:${id}` }, LIST_TIMEOUT_MS)
          if (response === null) {
            return null
          }
          // A workspace the host no longer lists runs nothing there.
          if (!response.ok) {
            return 0
          }
          const listed = HostTerminalList.safeParse(response.result)
          return listed.success
            ? listed.data.terminals.filter((terminal) => terminal.connected).length
            : 0
        },
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      })
    }
  }
}
