import type { IpcMainInvokeEvent } from 'electron'
import type { ResourceViewAdmission } from '../../../../shared/diagnostics/resource-view-admission'
import { assertResourceViewVisible } from '../../../window/visibility/resource-view-admission'
import { getPtyIpc } from '../pty-host-bindings'
import {
  PtyProcessListAdmission,
  visitPtyProcessListingsInBatches
} from '../../../providers/pty/process-list-admission'
import {
  ptySessionIdentity,
  type PtyListedSession,
  type PtySessionListScope
} from '../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import { ptyOwnership } from '../provider/ownership-state'
import { getProvider, registeredPtyProviders, type ResolvedPtyHost } from '../provider/registry'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'

export function installPtySessionListingIpcHandler(deps: {
  getLocalPtyProviderStartupPromise: (hostId?: ResolvedPtyHost) => Promise<void> | undefined
}): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyProviderStartupPromise } = deps
  // In-flight listings a view may retire, keyed by renderer and request; each entry ends with its request.
  const listings = new Map<string, { wanted: boolean }>()
  ipcMain.on('pty:retireListSessions', (event, requestId: unknown) => {
    const listing =
      typeof requestId === 'string' ? listings.get(`${event.sender.id}:${requestId}`) : undefined
    if (listing) {
      listing.wanted = false
    }
  })

  ipcMain.handle(
    'pty:listSessions',
    async (
      event: IpcMainInvokeEvent,
      scope?: PtySessionListScope,
      viewAdmission?: ResourceViewAdmission
    ): Promise<PtyListedSession[]> => {
      const requestId = viewAdmission?.requestId
      const key = typeof requestId === 'string' ? `${event.sender.id}:${requestId}` : null
      const listing = { wanted: true }
      if (key) {
        listings.set(key, listing)
      }
      // A hidden window or a retired request drops the reply, so its outdated reads are not repeated.
      const isWanted = (): boolean => {
        if (!listing.wanted) {
          return false
        }
        try {
          assertResourceViewVisible(event, viewAdmission)
          return true
        } catch {
          return false
        }
      }
      try {
        return await listForCaller(event, isWanted, scope, viewAdmission)
      } catch (error) {
        // A listing the view gave up on reports that, so the view never shows it as a failure.
        if (!isWanted()) {
          throw new Error('view_not_visible')
        }
        throw error
      } finally {
        if (key && listings.get(key) === listing) {
          listings.delete(key)
        }
      }
    }
  )

  async function listForCaller(
    event: IpcMainInvokeEvent,
    isWanted: () => boolean,
    scope?: PtySessionListScope,
    viewAdmission?: ResourceViewAdmission
  ): Promise<PtyListedSession[]> {
    assertResourceViewVisible(event, viewAdmission)
    if (scope !== undefined) {
      if (
        !scope ||
        (scope.includeUnrouted !== undefined && typeof scope.includeUnrouted !== 'boolean') ||
        (scope.includeUnrouted === true &&
          (scope.connectionId !== null || viewAdmission?.resourceManagerView !== true)) ||
        (scope.connectionId !== null &&
          (typeof scope.connectionId !== 'string' || !scope.connectionId.trim()))
      ) {
        throw new Error('invalid_pty_session_list_scope')
      }
      // Select the daemon only after startup has handed off ownership.
      if (scope.connectionId === null) {
        await getLocalPtyProviderStartupPromise()
      }
    }
    assertResourceViewVisible(event, viewAdmission)
    const deduped = new Map<string, PtyListedSession>()
    const admission = new PtyProcessListAdmission()
    const diagnostic = scope?.includeUnrouted === true
    await visitPtyProcessListingsInBatches(
      scope === undefined
        ? registeredPtyProviders()
        : [
            {
              provider: getProvider(getConnectionExecutionHostId(scope.connectionId)),
              hostId: getConnectionExecutionHostId(scope.connectionId)
            }
          ],
      ({ provider, hostId }) => {
        assertResourceViewVisible(event, viewAdmission)
        if (diagnostic && hostId === LOCAL_EXECUTION_HOST_ID) {
          return provider.listProcesses({ includeUnrouted: true, isWanted })
        }
        return hostId === LOCAL_EXECUTION_HOST_ID || scope !== undefined
          ? provider.listProcesses({ isWanted })
          : provider.listProcesses({ isWanted }).catch(() => [])
      },
      ({ provider, hostId }, sessions) => {
        const seen = new Set<string>()
        const duplicated = new Set<string>()
        for (const session of sessions) {
          if (seen.has(session.id)) {
            duplicated.add(session.id)
          }
          seen.add(session.id)
        }
        for (const rawSession of sessions) {
          const session = admission.admit(rawSession)
          // Rebuild routing for reconnect-discovered sessions; later kill requests carry only the PTY ID.
          ptyOwnership.set(session.id, hostId)
          deduped.set(diagnostic ? ptySessionIdentity(session) : session.id, {
            id: session.id,
            ...(session.inventorySourceId !== undefined
              ? { inventorySourceId: session.inventorySourceId }
              : {}),
            ...(session.routed !== undefined ? { routed: session.routed } : {}),
            cwd: session.cwd,
            title: session.title,
            ...(session.foregroundProcess ? { foregroundProcess: session.foregroundProcess } : {}),
            ...(session.rootProcessId !== undefined && session.rootProcessId > 0
              ? { rootProcessId: session.rootProcessId }
              : {}),
            ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
            fencedTermination:
              !duplicated.has(session.id) &&
              hostId === LOCAL_EXECUTION_HOST_ID &&
              provider.supportsFencedTermination?.(session.id) === true,
            ...(session.worktreeId !== undefined ? { worktreeId: session.worktreeId } : {}),
            ...(session.paneKey !== undefined ? { paneKey: session.paneKey } : {}),
            ...(session.exiting === true ? { exiting: true as const } : {}),
            // During restore, claims provide liveness evidence; only listing-capable providers can prove ownership absent (#8459).
            agentOwnership:
              (session.agentSessionOwners?.length ?? 0) > 0
                ? 'present'
                : !duplicated.has(session.id) &&
                    provider.providesAgentSessionOwnerListings?.(session.id) === true
                  ? 'absent'
                  : 'unknown'
          })
        }
      }
    )
    return Array.from(deduped.values())
  }
}
