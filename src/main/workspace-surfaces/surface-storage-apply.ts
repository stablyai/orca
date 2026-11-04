import { retireSurfaceRunAfterKernelChange } from './surface-kernel-retirement'
import { showNativeSurface } from './surface-native-show'
import type Database from '../sqlite/sync-database'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
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
import {
  reconcileLegacyTerminalSurfaces,
  retainImportedAdoption
} from './surface-terminal-reconciliation'

/** Applies only inside the admitted owner's transaction; publication waits for its common commit. */
export function applySurfaceStorageCommand(
  db: Database.Database,
  repository: WorkspaceSurfaceRepository,
  previous: SurfaceProfileDomain,
  hostId: ExecutionHostId,
  storedSession: WorkspaceSessionState,
  command: Exclude<SurfaceStorageCommand, { type: 'query' }>,
  mintId: () => string,
  now: () => number
): { session: WorkspaceSessionState; outcome: SurfaceStorageResult['outcome'] } {
  let session = storedSession
  let outcome: SurfaceStorageResult['outcome'] = null
  switch (command.type) {
    case 'initialize': {
      if (!repository.initialized(hostId)) {
        const host = previous.hosts[hostId] ?? emptySurfaceHostDomain()
        const seeds = seedWorkspaceSurfaces(hostId, storedSession, [], mintId, host)
        repository.initialize(
          hostId,
          seeds.filter((surface) => surface.content?.kind === 'terminal'),
          Object.keys(storedSession.tabsByWorktree)
        )
        for (const surface of seeds) {
          retainImportedAdoption(db, surface)
        }
        previous.hosts[hostId] = host
      } else {
        reconcileLegacyTerminalSurfaces(db, hostId, storedSession, previous.hosts[hostId]!, mintId)
      }
      break
    }
    case 'layout': {
      assertRequestHost(hostId, command.request.hostId)
      const loaded = loadWorkspaceLayoutWithoutReport(
        hostId,
        command.session,
        nameBasedLoadContext()
      )
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
        }
      )
      break
    }
    case 'show-native':
      assertRequestHost(hostId, command.identity.hostId)
      outcome = showNativeSurface(db, repository, storedSession, command)
      break
    case 'replace':
      assertRequestHost(hostId, command.request.hostId)
      outcome = repository.replaceContent(command.request)
      break
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
