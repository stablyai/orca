import type { ResourceViewAdmission } from '../../../../shared/resource-view-admission'
import { assertResourceViewVisible } from '../../../window/resource-view-admission'
import { getPtyIpc } from '../../pty-host-bindings'
import {
  PtyProcessListAdmission,
  visitPtyProcessListingsInBatches
} from '../../../providers/pty-process-list-admission'
import {
  ptySessionIdentity,
  type PtyListedSession,
  type PtySessionListScope
} from '../../../../shared/pty-listed-session'
import { ptyOwnership } from '../provider/ownership-state'
import { getProvider, registeredPtyProviders, type ResolvedPtyHost } from '../provider/registry'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'

export function installPtySessionListingIpcHandler(deps: {
  getLocalPtyProviderStartupPromise: (hostId?: ResolvedPtyHost) => Promise<void> | undefined
}): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyProviderStartupPromise } = deps

  ipcMain.handle(
    'pty:listSessions',
    async (
      event,
      scope?: PtySessionListScope,
      viewAdmission?: ResourceViewAdmission
    ): Promise<PtyListedSession[]> => {
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
            return provider.listProcesses({ includeUnrouted: true })
          }
          return hostId === LOCAL_EXECUTION_HOST_ID || scope !== undefined
            ? provider.listProcesses()
            : provider.listProcesses().catch(() => [])
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
              ...(session.foregroundProcess
                ? { foregroundProcess: session.foregroundProcess }
                : {}),
              ...(session.rootProcessId !== undefined && session.rootProcessId > 0
                ? { rootProcessId: session.rootProcessId }
                : {}),
              ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
              fencedTermination:
                !duplicated.has(session.id) &&
                hostId === LOCAL_EXECUTION_HOST_ID &&
                provider.supportsFencedTermination?.(session.id) === true,
              ...(session.worktreeId !== undefined ? { worktreeId: session.worktreeId } : {}),
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
  )
}
