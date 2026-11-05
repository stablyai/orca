import { attachSurfaceEvidenceReader } from './surface-cold-evidence'
import {
  hasClosedTerminalTabRecord,
  recordClosedTerminalTabTombstone,
  pruneClosedTerminalTabTombstones
} from '../../shared/workspace-layout/closed-terminal-tab-tombstones'
import { invalidateSurfaceCapture } from './surface-transaction-changes'
import { readSurfaceHostSession } from './surface-host-profile-session'
import { retireSurfaceRunAfterKernelChange } from './surface-kernel-retirement'
import { showNativeSurface } from './surface-native-show'
import type Database from '../sqlite/sync-database'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import type { SurfaceProfileDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import { emptySurfaceHostDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import type {
  SurfaceStorageCommand,
  SurfaceStorageResult
} from '../../shared/workspace-surfaces/surface-storage-command'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSurfaceRepository } from './surface-repository'
import { seedWorkspaceSurfaces } from './surface-migration'
import { reconcileLegacyTerminalSurfaces } from './surface-terminal-reconciliation'

/** Applies only inside the admitted owner's transaction; publication waits for its common commit. */
export function applySurfaceStorageCommand(
  db: Database.Database,
  repository: WorkspaceSurfaceRepository,
  previous: SurfaceProfileDomain,
  hostId: ExecutionHostId,
  storedSession: WorkspaceSessionState,
  command: Exclude<SurfaceStorageCommand, { type: 'query' }>,
  mintId: () => string,
  now: () => number,
  native = false
): { session: WorkspaceSessionState; outcome: SurfaceStorageResult['outcome'] } {
  let session = storedSession
  let outcome: SurfaceStorageResult['outcome'] = null
  let otherCloseEvidence: WorkspaceSessionState[] | undefined
  switch (command.type) {
    case 'initialize': {
      if (!repository.initialized(hostId)) {
        const host = previous.hosts[hostId] ?? emptySurfaceHostDomain()
        attachSurfaceEvidenceReader(db, hostId, host)
        const seeds = seedWorkspaceSurfaces(hostId, storedSession, [], mintId, host)
        repository.initialize(
          hostId,
          seeds.filter((surface) => surface.content?.kind === 'terminal'),
          Object.keys(storedSession.tabsByWorktree)
        )
        previous.hosts[hostId] = host
      } else {
        attachSurfaceEvidenceReader(db, hostId, previous.hosts[hostId]!)
        reconcileLegacyTerminalSurfaces(db, hostId, storedSession, previous.hosts[hostId]!, mintId)
      }
      if (!native) {
        previous.hosts[hostId]!.chatInitialization = 'unknown'
      }
      break
    }
    case 'layout': {
      assertRequestHost(hostId, command.request.hostId)
      const loaded = loadWorkspaceLayoutWithoutReport(
        hostId,
        {
          ...command.session,
          closedTerminalTabTombstonesByTabId: storedSession.closedTerminalTabTombstonesByTabId
        },
        nameBasedLoadContext()
      )
      const input = command.request.command
      const groupId = 'groupId' in input ? input.groupId : undefined
      const suppliedGroup = command.session.tabGroups?.[input.workspace]?.find(
        (group) => group.id === groupId
      )
      const workspace = loaded.layout.workspaces[input.workspace]
      if (suppliedGroup && workspace && !workspace.groups.some((group) => group.id === groupId)) {
        workspace.groups.push({ id: suppliedGroup.id, tabOrder: [] })
      }
      const bindings = new Map(command.facts.bindings.map((binding) => [binding.paneKey, binding]))
      const starting = new Set(command.facts.startingLeafIds)
      outcome = repository.applyLayout(
        command.request,
        {
          model: loaded.layout,
          chatVerified: previous.hosts[hostId]?.chatInitialization === 'verified',
          context: {
            mintId,
            mintLeafId: mintId,
            now,
            droppedLeafReason: 'live-edit',
            isStarting: (leafId) => starting.has(leafId),
            isBindingLive: (paneKey, ptyId) => {
              const binding = bindings.get(paneKey)
              return binding?.ptyId === ptyId && binding.live
            },
            retiresBinding: (paneKey, ptyId) => {
              const binding = bindings.get(paneKey)
              return binding?.ptyId === ptyId && binding.retiring
            }
          }
        },
        (layout) => {
          session = saveWorkspaceLayout({ ...loaded, layout })
          const input = command.request.command
          const tabIds =
            input.type === 'closeTabs'
              ? input.tabIds
              : input.type === 'closePane'
                ? [input.tabId]
                : []
          for (const tabId of tabIds) {
            const before = previous.hosts[hostId]?.surfaces.find(
              (surface) => surface.workspaceId === input.workspace && surface.hostTabId === tabId
            )
            const oldTab = loaded.layout.workspaces[input.workspace]?.tabs.find(
              (tab) => tab.id === tabId
            )
            if (
              (before?.content && before.content.kind !== 'terminal') ||
              (oldTab && oldTab.kind !== 'terminal') ||
              layout.workspaces[input.workspace]?.tabs.some((tab) => tab.id === tabId)
            ) {
              continue
            }
            invalidateSurfaceCapture(db, { hostId, workspaceId: input.workspace, hostTabId: tabId })
            session.closedTerminalTabTombstonesByTabId = recordClosedTerminalTabTombstone(
              session.closedTerminalTabTombstonesByTabId,
              before?.content?.kind === 'terminal' ? before.content.entityId : tabId,
              {
                worktreeId: input.workspace,
                ...(input.type === 'closeTabs' && input.recordClose
                  ? { reason: input.recordClose }
                  : {})
              },
              now()
            )
          }
          session.closedTerminalTabTombstonesByTabId = pruneClosedTerminalTabTombstones(
            session.closedTerminalTabTombstonesByTabId,
            now()
          )
        },
        (tabId, workspaceId) => {
          if (
            hasClosedTerminalTabRecord(
              storedSession.closedTerminalTabTombstonesByTabId,
              tabId,
              workspaceId,
              now()
            )
          ) {
            return true
          }
          if (!otherCloseEvidence) {
            const row = db
              .prepare(
                "SELECT payload FROM main.profile_state_documents WHERE domain = 'workspaceSessionsByHostId'"
              )
              .get()
            const remote: Record<string, WorkspaceSessionState> =
              typeof row?.payload === 'string' ? (JSON.parse(row.payload) ?? {}) : {}
            otherCloseEvidence = [readSurfaceHostSession(db, 'local'), ...Object.values(remote)]
          }
          return otherCloseEvidence.some((current) =>
            hasClosedTerminalTabRecord(
              current.closedTerminalTabTombstonesByTabId,
              tabId,
              workspaceId,
              now()
            )
          )
        }
      )
      break
    }
    case 'show-native':
      assertRequestHost(hostId, command.identity.hostId)
      outcome = showNativeSurface(db, repository, storedSession, command)
      break
    case 'replace': {
      assertRequestHost(hostId, command.request.hostId)
      const before = repository.read(command.request)
      outcome = repository.replaceContent(command.request, () => {
        if (
          command.request.content === null &&
          (!before?.content || before.content.kind === 'terminal')
        ) {
          session = {
            ...storedSession,
            closedTerminalTabTombstonesByTabId: recordClosedTerminalTabTombstone(
              storedSession.closedTerminalTabTombstonesByTabId,
              before?.content?.kind === 'terminal'
                ? before.content.entityId
                : command.request.hostTabId,
              { worktreeId: command.request.workspaceId },
              now()
            )
          }
        }
      })
      break
    }
    case 'move':
      assertRequestHost(hostId, command.request.hostId)
      outcome = repository.move(command.request)
      break
    case 'begin-run':
      assertRequestHost(hostId, command.target.hostId)
      outcome = repository.runs.beginRun(
        command.target,
        command.resourceId,
        command.executorId,
        command.provenance
      )
      break
    case 'bind-run':
      outcome = repository.runs.bindRun(hostId, command.allocationId, command.resource)
      break
    case 'abort-run':
      outcome = repository.runs.abortRun(hostId, command.allocationId)
      break
    case 'retire-kernel-run':
      assertRequestHost(hostId, command.subject.target.hostId)
      outcome = retireSurfaceRunAfterKernelChange(db, command.subject, command.observer, mintId)
      break
    case 'acknowledge-run':
      assertRequestHost(hostId, command.acknowledgment.hostId)
      outcome = repository.runs.acknowledgeRun(command.acknowledgment)
      break
  }
  return { session, outcome }
}

function assertRequestHost(hostId: string, requestHostId: string): void {
  if (hostId !== requestHostId) {
    throw new Error('Surface command crosses execution hosts')
  }
}
