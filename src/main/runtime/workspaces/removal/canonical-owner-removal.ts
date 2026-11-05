import { isWslMoveWorkspaceSessionFrozen } from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSurface } from '../../../../shared/workspace-surfaces/surface-content'
import type {
  SurfaceStorageMutation,
  SurfaceStorageResult
} from '../../../../shared/workspace-surfaces/surface-storage-command'
import type { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'
import type { RuntimeStore } from '../../runtime-store-contract'

export type NativeOwnerRemovalStore = Pick<AgentSessionRecordStore, 'commitSurfaceCommands'>
export type OpenNativeOwnerRemovalStore = () => Promise<NativeOwnerRemovalStore>
export type CapturedOwnerRemoval = <T>(finalize: () => T) => Promise<T>

export class WorkspaceOwnerRemovalError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'WorkspaceOwnerRemovalError'
  }
}

/** Capture ownership before teardown; facts of the same admitted run may still arrive. */
export function captureCanonicalOwnerRemoval(
  store: RuntimeStore,
  matches: (hostId: ExecutionHostId, surface: WorkspaceSurface) => boolean,
  openNative?: OpenNativeOwnerRemovalStore,
  validate: () => void = () => {}
): CapturedOwnerRemoval {
  if (!store.readWorkspaceSurfaces || !store.executeWorkspaceSurfaceTransaction) {
    return async (finalize) => {
      validate()
      return finalize()
    }
  }
  const read = () =>
    (store.getWorkspaceSessionHostIds?.() ?? ['local' as const])
      .flatMap((hostId) =>
        parseExecutionHostId(hostId)?.kind === 'runtime'
          ? []
          : store.readWorkspaceSurfaces!(hostId).filter(
              (surface) =>
                surface.content &&
                !isWslMoveWorkspaceSessionFrozen(surface.workspaceId) &&
                matches(hostId, surface)
            )
      )
      .sort((a, b) =>
        JSON.stringify([a.hostId, a.workspaceId, a.hostTabId]).localeCompare(
          JSON.stringify([b.hostId, b.workspaceId, b.hostTabId])
        )
      )
  const captured = structuredClone(read())
  const identities = (surfaces: readonly WorkspaceSurface[]) =>
    surfaces.map((surface) => ({
      hostId: surface.hostId,
      workspaceId: surface.workspaceId,
      hostTabId: surface.hostTabId,
      occurrence: surface.occurrence,
      content:
        surface.content?.kind === 'terminal'
          ? {
              kind: surface.content.kind,
              entityId: surface.content.entityId,
              leaves: Object.entries(surface.content.leaves)
                .map(([leafId, leaf]) => [leafId, leaf.occurrence, leaf.runId])
                .sort()
            }
          : surface.content
    }))
  const expected = identities(captured)
  let commands: SurfaceStorageMutation[] | undefined
  const prepareCommands = () =>
    (commands ??= captured.map((surface) => ({
      type: 'replace',
      hostId: surface.hostId,
      request: {
        hostId: surface.hostId,
        workspaceId: surface.workspaceId,
        hostTabId: surface.hostTabId,
        expected: { occurrence: surface.occurrence },
        content: null,
        callerId: 'owner-removal',
        commandId: randomUUID(),
        expiresAt: Date.now() + 720_000
      }
    })))
  const admit = () => {
    validate()
    if (!isDeepStrictEqual(expected, identities(read()))) {
      throw new Error('Workspace contents changed during removal. Try removing it again.')
    }
  }
  const remove: CapturedOwnerRemoval = async (finalize) => {
    let value: ReturnType<typeof finalize>
    const complete = (results: readonly SurfaceStorageResult[]) => {
      if (
        results.some(
          ({ outcome }) =>
            !outcome ||
            typeof outcome !== 'object' ||
            !('status' in outcome) ||
            outcome.status !== 'accepted'
        )
      ) {
        throw new Error('Workspace contents changed before removal could be saved. Try again.')
      }
      value = finalize()
    }
    if (captured.some((surface) => surface.content?.kind === 'agent-session')) {
      if (!openNative) {
        throw new Error('Chat storage must be available before removing this workspace')
      }
      const native = await openNative()
      await native.commitSurfaceCommands(prepareCommands(), admit, (result) =>
        complete(result.surfaces)
      )
    } else {
      await store.executeWorkspaceSurfaceTransaction!(() => {
        admit()
        return prepareCommands()
      }, complete)
    }
    return value!
  }
  return async (finalize) => {
    try {
      return await remove(finalize)
    } catch (error) {
      throw new WorkspaceOwnerRemovalError(error)
    }
  }
}
