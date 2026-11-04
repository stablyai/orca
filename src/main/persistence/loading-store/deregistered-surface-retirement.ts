import { collectDeregisteredRepoIds } from '../tracking-repos/deregistered-repo-residue'
import { isWslMoveWorkspaceSessionFrozen } from '../moving-wsl-projects/wsl-move-scope-guard'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  orphanSurfaceRetirements,
  assertOrphanRetirementsAccepted
} from '../../workspace-surfaces/surface-orphan-retirement'
import type { StoreRuntimeState } from './store-runtime-state'
import type { PrimaryStateWriteOperations } from './primary-state-writes'
import {
  publishCommittedSurfaceCommand,
  readSurfaceRuntimeSession
} from './surface-committed-publication'

export function readDeregisteredWorkspaceSurfaces(runtime: StoreRuntimeState) {
  const reader = runtime.workspaceSurfaces
  const surfaces = (reader?.hostIds?.() ?? []).flatMap((host) => reader!.all(host))
  const orphanIds = collectDeregisteredRepoIds(runtime.state, surfaces)
  return surfaces.filter((surface) => {
    const repoId = splitWorktreeId(surface.workspaceId)?.repoId
    return (
      surface.content &&
      repoId &&
      orphanIds.has(repoId) &&
      parseExecutionHostId(surface.hostId)?.kind !== 'runtime' &&
      !isWslMoveWorkspaceSessionFrozen(surface.workspaceId)
    )
  })
}

export function pruneDeregisteredTerminalSurfacesSync(
  runtime: StoreRuntimeState,
  writes: PrimaryStateWriteOperations
): void {
  const commands = orphanSurfaceRetirements(
    readDeregisteredWorkspaceSurfaces(runtime).filter(
      (surface) => surface.content?.kind === 'terminal'
    )
  )
  if (!commands.length) {
    return
  }
  const authority = runtime.profileStateAuthority
  if (!authority || authority.asynchronous || !authority.executeSurfaceTransaction) {
    throw new Error('Synchronous surface cleanup requires its admitted profile owner')
  }
  writes.flushOrThrow()
  const generation = runtime.writeGeneration
  const before = commands.map((command) =>
    structuredClone(readSurfaceRuntimeSession(runtime, command.hostId as ExecutionHostId))
  )
  const results = authority.executeSurfaceTransaction(commands)
  assertOrphanRetirementsAccepted(results)
  for (const [index, result] of results.entries()) {
    publishCommittedSurfaceCommand(
      runtime,
      result.hostId as ExecutionHostId,
      commands[index]!,
      before[index]!,
      generation,
      result
    )
  }
}
