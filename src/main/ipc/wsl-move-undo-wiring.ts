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
import { wslMoveReleasedSessionFocusPatch } from '../persistence/moving-wsl-projects/wsl-move-session-rewrite'
import { applyWslMoveSessionFocus } from '../persistence/moving-wsl-projects/wsl-move-main-rewrite-stores'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import { wasWslHostKeptForPeers } from '../wsl/wsl-host-kept-for-peers'
import {
  stopWslMoveHostAutomations,
  wslMoveMovedAutomationIds,
  type WslMoveHostAutomationStop
} from '../persistence/moving-wsl-projects/wsl-move-undo-host-automations'
import { scheduleWslMoveRewriteRetry } from '../persistence/moving-wsl-projects/wsl-move-rewrite-retry'
import { connectWslMoveHostService, wslHostRemovalPending } from './wsl-move-host-connect'
import { getWslHostService } from '../wsl/wsl-host-service-instance'
import {
  disableWslHostAutomations,
  readWslHostAutomationStates,
  restoreWslHostAutomations
} from './wsl-host-automation-disable'

export type WslMoveUndoPorts = {
  stopHostCopies: (move: WslMoveCutover) => Promise<WslMoveHostCopyStop>
  /** First, before the terminals stop: the host's copies of the move's automations turn off. */
  stopHostAutomations?: (move: WslMoveCutover) => Promise<WslMoveHostAutomationStop>
  /** After the release, with window writes held: focus on the host copy returns here. */
  refocusHere?: (move: WslMoveCutover) => void
}

// What undo reads of the host's terminal list: whether each terminal is still running.
const HostTerminalList = z.object({
  terminals: z.array(
    z.object({ connected: z.boolean(), worktreeId: z.string().optional() }).passthrough()
  ),
  truncated: z.boolean().optional()
})

// The host's answer for a workspace selector it does not have.
const HOST_WORKSPACE_NOT_FOUND = 'selector_not_found'

// Far above any host's terminal count; a list cut off at it cannot prove what runs there.
const HOST_TERMINAL_LIST_LIMIT = 10_000

const SLEEP_TIMEOUT_MS = 60_000
const LIST_TIMEOUT_MS = 10_000

/** Undo is the user's act: after a relaunch a host with no open work connects first, as Connect would. */
async function connectUndoHost(userDataPath: string, move: WslMoveCutover): Promise<boolean> {
  const service = getWslHostService()
  if (!service) {
    return true
  }
  try {
    await connectWslMoveHostService(service, userDataPath, move.manifest.source.distro, 'user')
    return true
  } catch (error) {
    console.warn('[wsl-move] The host did not connect for undo:', error)
    return false
  }
}

export function createWslMoveUndoPorts(
  store: Pick<
    Store,
    'getWorkspaceSession' | 'patchWorkspaceSession' | 'listAutomations' | 'updateAutomation'
  >,
  userDataPath: string
): WslMoveUndoPorts {
  return {
    stopHostCopies: async (move) => {
      // A host the user removed ran its terminals down with it, unless its Remove kept the server
      // running for another Orca (R39): then its copies may still run, and nothing here reaches them.
      if (!listEnvironments(userDataPath).some((env) => env.id === move.destinationEnvironmentId)) {
        return wasWslHostKeptForPeers(userDataPath, move.destinationEnvironmentId)
          ? 'unreachable'
          : 'stopped'
      }
      const scope = wslMoveRewriteScope(wslMoveDesktopRewriteContext(userDataPath, move))
      const local = store.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID)
      const hostIds = [...new Set(Object.keys(local.tabsByWorktree).filter(scope.inScope))].map(
        (id) => scope.worktreeId(id)
      )
      if (!(await connectUndoHost(userDataPath, move))) {
        return 'unreachable'
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
        workspacesWithTerminals: async () => {
          const response = await call(
            'terminal.list',
            { limit: HOST_TERMINAL_LIST_LIMIT, includeVisualLayouts: false },
            LIST_TIMEOUT_MS
          )
          const listed = response?.ok ? HostTerminalList.safeParse(response.result) : null
          // An error answer, an unreadable one or a cut-off list cannot prove what runs there.
          if (!listed?.success || listed.data.truncated === true) {
            return null
          }
          return [
            ...new Set(
              listed.data.terminals
                .map((terminal) => terminal.worktreeId)
                .filter((id): id is string => typeof id === 'string' && scope.inScope(id))
            )
          ]
        },
        sleepWorkspace: async (id) => {
          const response = await call('worktree.sleep', { worktree: `id:${id}` }, SLEEP_TIMEOUT_MS)
          return response === null ? null : response.ok
        },
        liveTerminals: async (id) => {
          const response = await call('terminal.list', { worktree: `id:${id}` }, LIST_TIMEOUT_MS)
          if (response === null) {
            return null
          }
          if (!response.ok) {
            // A workspace the host no longer has runs nothing there; any other error proves nothing.
            return response.error.code === HOST_WORKSPACE_NOT_FOUND ? 0 : null
          }
          const listed = HostTerminalList.safeParse(response.result)
          return listed.success
            ? listed.data.terminals.filter((terminal) => terminal.connected).length
            : null
        },
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      })
    },
    stopHostAutomations: async (move) => {
      // Inside a try: a throw here would otherwise escape past undo's spawn fence.
      try {
        // A removed host took its automations with it, unless another Orca keeps its server (R39).
        if (
          !listEnvironments(userDataPath).some((env) => env.id === move.destinationEnvironmentId)
        ) {
          return wasWslHostKeptForPeers(userDataPath, move.destinationEnvironmentId)
            ? { outcome: 'unreachable' }
            : { outcome: 'stopped', restore: async () => {}, applyHere: () => () => {} }
        }
        // E11: a Remove that could not prove the server stopped; the host is not to be touched.
        if (wslHostRemovalPending(userDataPath, move.manifest.source.distro)) {
          return { outcome: 'removal-pending' }
        }
        if (!(await connectUndoHost(userDataPath, move))) {
          return { outcome: 'unreachable' }
        }
        const environmentId = move.destinationEnvironmentId
        const stop = await stopWslMoveHostAutomations(
          userDataPath,
          move.migrationId,
          wslMoveMovedAutomationIds(move),
          {
            read: (ids) => readWslHostAutomationStates(userDataPath, environmentId, ids),
            disable: (ids) => disableWslHostAutomations(userDataPath, environmentId, ids),
            restore: (ids) => restoreWslHostAutomations(userDataPath, environmentId, ids),
            listHere: () => store.listAutomations(),
            setHere: (id, enabled) => {
              store.updateAutomation(id, { enabled })
            }
          }
        )
        // Whatever a refusal left off on the host is retried until it is back on.
        if (stop.outcome !== 'stopped') {
          scheduleWslMoveRewriteRetry(userDataPath)
          return stop
        }
        return {
          ...stop,
          restore: async () => {
            await stop.restore()
            scheduleWslMoveRewriteRetry(userDataPath)
          }
        }
      } catch (error) {
        console.warn('[wsl-move] Could not read what undo turns off on the host:', error)
        return { outcome: 'failed' }
      }
    },
    refocusHere: (move) => {
      applyWslMoveSessionFocus(
        store,
        wslMoveRewriteScope(wslMoveDesktopRewriteContext(userDataPath, move)),
        wslMoveReleasedSessionFocusPatch
      )
    }
  }
}
