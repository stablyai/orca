import type { PtyOwnershipTransferSurfacePublicationRequest as PtyOwnershipTransferDestinationPublicationRequest } from '../pty-ownership-transfer/pty-ownership-transfer-surface-publication'
import type { PtyOwnershipTransferPublicationReceipt } from '../../../shared/pty-ownership-transfer-journal-contract'
import { publicationReceiptMatchesPtyOwnershipTransfer } from '../../../shared/pty-ownership-transfer-receipt-validation'
import {
  parsePtyOwnershipTransferSurfaceBinding,
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from '../../../shared/pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferWireIdentity } from '../../../shared/pty-ownership-transfer-wire'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  terminalScrollbackStoredBytesEqualSync,
  writeTerminalScrollbackStoredBytesDurableSync
} from '../../terminal-scrollback-durable-artifact'
import { readTerminalScrollbackStoredBytesSync } from '../../terminal-scrollback-snapshots'
import {
  ownershipTransferSurfaceSnapshotRef,
  ownershipTransferSurfaceModelSnapshotRef
} from '../pty-ownership-transfer/pty-ownership-transfer-snapshot-reference'
import type { PtyOwnershipTransferSurfacePublicationState } from '../pty-ownership-transfer/pty-ownership-transfer-surface-publication'
import { inspectPtyOwnershipTransferBindingAdmission } from './pty-ownership-transfer-binding-admission'
import type { PtyBindingPersistenceOperations } from './pty-binding-persistence'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import type { StoreRuntimeState } from './store-runtime-state'
import { inspectPtyOwnershipTransferCatalogSurface } from './pty-ownership-transfer-catalog-surface-admission'
import {
  prepareOrcadTerminalLayoutAdmission,
  type OrcadTerminalLayoutAdmission
} from '../migrating-orcad-catalog/orcad-terminal-layout-admission'

type PtyOwnershipTransferSurfacePersistenceRuntime = Pick<
  StoreRuntimeState,
  | 'flushOrThrow'
  | 'terminalScrollbackSnapshotStorage'
  | 'transferSnapshotHistory'
  | 'dataFile'
  | 'state'
>

export type PtyOwnershipTransferTerminalModelCheckpointRequest = Readonly<{
  identity: PtyOwnershipTransferWireIdentity
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  publicationReceipt: PtyOwnershipTransferPublicationReceipt
  modelData: string
  allowEmpty?: true
}>

const surfacePersistenceContext = Symbol('PtyOwnershipTransferSurfacePersistence')

type SurfacePersistenceContext = {
  runtime: PtyOwnershipTransferSurfacePersistenceRuntime
  sessions: SessionHostPartitionOperations
  ptyBindings: PtyBindingPersistenceOperations
}

export class PtyOwnershipTransferSurfacePersistence {
  readonly [surfacePersistenceContext]: SurfacePersistenceContext

  constructor(
    runtime: PtyOwnershipTransferSurfacePersistenceRuntime,
    sessions: SessionHostPartitionOperations,
    ptyBindings: PtyBindingPersistenceOperations
  ) {
    this[surfacePersistenceContext] = { runtime, sessions, ptyBindings }
  }

  preparePtyOwnershipTransferCatalogAdmission(
    manifest: OrcadTerminalLayoutAdmission['manifest'],
    bindings: OrcadTerminalLayoutAdmission['bindings']
  ): OrcadTerminalLayoutAdmission {
    const { runtime } = this[surfacePersistenceContext]
    const admission = prepareOrcadTerminalLayoutAdmission(
      manifest,
      bindings,
      runtime.state,
      runtime
    )
    runtime.flushOrThrow()
    return admission
  }

  inspectPtyOwnershipTransferSurface(
    request: PtyOwnershipTransferDestinationPublicationRequest
  ): PtyOwnershipTransferSurfacePublicationState {
    const context = this[surfacePersistenceContext]
    const binding = parsePtyOwnershipTransferSurfaceBinding(request.surfaceBinding)
    const ownerKey = ownershipTransferSurfaceOwnerKey(binding.workspaceKey)
    const session = context.sessions.getWorkspaceSession(binding.executionHostId)
    let catalog: ReturnType<typeof inspectPtyOwnershipTransferCatalogSurface>
    try {
      catalog = inspectPtyOwnershipTransferCatalogSurface(context.runtime, session, request)
    } catch {
      return 'conflict'
    }
    const admission =
      catalog?.state ??
      inspectPtyOwnershipTransferBindingAdmission(session, {
        worktreeId: ownerKey,
        tabId: binding.tabId,
        leafId: binding.leafId,
        ptyId: binding.ptyId,
        incarnationId: request.identity.incarnationId
      })
    if (admission === 'conflict') {
      return 'conflict'
    }
    if (catalog && admission === 'absent') {
      return 'absent'
    }
    const layout = session.terminalLayoutsByTabId[binding.tabId]
    const ref = layout?.scrollbackRefsByLeafId?.[binding.leafId]
    const hasInlineBuffer = Object.hasOwn(layout?.buffersByLeafId ?? {}, binding.leafId)
    if (!ref && !hasInlineBuffer) {
      return 'absent'
    }
    const expectedRef = ownershipTransferSurfaceSnapshotRef(request)
    const modelRef = ownershipTransferSurfaceModelSnapshotRef(request)
    if (
      admission !== 'published' ||
      hasInlineBuffer ||
      (ref === expectedRef
        ? !terminalScrollbackStoredBytesEqualSync(
            ref,
            ownershipTransferSurfaceBaseline(request),
            context.runtime.terminalScrollbackSnapshotStorage
          )
        : ref !== modelRef ||
          (readTerminalScrollbackStoredBytesSync(
            modelRef,
            context.runtime.terminalScrollbackSnapshotStorage
          ) === null &&
            !terminalScrollbackStoredBytesEqualSync(
              modelRef,
              '',
              context.runtime.terminalScrollbackSnapshotStorage
            )))
    ) {
      return 'conflict'
    }
    return 'published'
  }

  publishPtyOwnershipTransferSurface(
    request: PtyOwnershipTransferDestinationPublicationRequest
  ): void {
    const before = this.inspectPtyOwnershipTransferSurface(request)
    if (before === 'published') {
      return
    }
    if (before === 'conflict') {
      throw new Error('pty_ownership_transfer_surface_conflict')
    }
    const context = this[surfacePersistenceContext]
    const binding = parsePtyOwnershipTransferSurfaceBinding(request.surfaceBinding)
    const ownerKey = ownershipTransferSurfaceOwnerKey(binding.workspaceKey)
    const ref = ownershipTransferSurfaceSnapshotRef(request)
    const catalog = inspectPtyOwnershipTransferCatalogSurface(
      context.runtime,
      context.sessions.getWorkspaceSession(binding.executionHostId),
      request
    )
    context.runtime.transferSnapshotHistory.recordPublication(request)
    writeTerminalScrollbackStoredBytesDurableSync({
      ref,
      data: ownershipTransferSurfaceBaseline(request),
      storage: context.runtime.terminalScrollbackSnapshotStorage
    })
    const persisted = context.ptyBindings.persistPtyBinding(
      {
        worktreeId: ownerKey,
        tabId: binding.tabId,
        leafId: binding.leafId,
        ptyId: binding.ptyId,
        incarnationId: request.identity.incarnationId,
        bindingMode: 'strict-transfer-publication',
        scrollbackSnapshotRef: ref,
        ...(catalog ? { reservedTransferLayout: catalog.reservation } : {})
      },
      binding.executionHostId
    )
    if (!persisted) {
      throw new Error('pty_ownership_transfer_surface_conflict')
    }
    if (this.inspectPtyOwnershipTransferSurface(request) !== 'published') {
      throw new Error('pty_ownership_transfer_surface_publication_unverified')
    }
  }

  checkpointPtyOwnershipTransferTerminalModel(
    request: PtyOwnershipTransferTerminalModelCheckpointRequest
  ): void {
    const context = this[surfacePersistenceContext]
    const binding = parsePtyOwnershipTransferSurfaceBinding(request.surfaceBinding)
    if (
      (request.modelData.length === 0 && request.allowEmpty !== true) ||
      !publicationReceiptMatchesPtyOwnershipTransfer(
        request.publicationReceipt,
        request.identity,
        request.publicationReceipt.commitReceipt
      ) ||
      !samePtyOwnershipTransferSurfaceBinding(request.publicationReceipt.surfaceBinding, binding)
    ) {
      throw new Error('pty_ownership_transfer_model_checkpoint_invalid')
    }
    const ownerKey = ownershipTransferSurfaceOwnerKey(binding.workspaceKey)
    const session = context.sessions.getWorkspaceSession(binding.executionHostId)
    const catalog = inspectPtyOwnershipTransferCatalogSurface(context.runtime, session, request)
    const admission =
      catalog?.state ??
      inspectPtyOwnershipTransferBindingAdmission(session, {
        worktreeId: ownerKey,
        tabId: binding.tabId,
        leafId: binding.leafId,
        ptyId: binding.ptyId,
        incarnationId: request.identity.incarnationId
      })
    const layout = session.terminalLayoutsByTabId[binding.tabId]
    const ref = layout?.scrollbackRefsByLeafId?.[binding.leafId]
    const expectedRef = ownershipTransferSurfaceSnapshotRef({
      surfaceBinding: binding,
      publicationReceipt: request.publicationReceipt
    })
    const modelRef = ownershipTransferSurfaceModelSnapshotRef({
      surfaceBinding: binding,
      publicationReceipt: request.publicationReceipt
    })
    if (
      admission !== 'published' ||
      (ref !== expectedRef && ref !== modelRef) ||
      Object.hasOwn(layout?.buffersByLeafId ?? {}, binding.leafId)
    ) {
      throw new Error('pty_ownership_transfer_model_checkpoint_conflict')
    }
    if (
      !terminalScrollbackStoredBytesEqualSync(
        modelRef,
        request.modelData,
        context.runtime.terminalScrollbackSnapshotStorage
      )
    ) {
      writeTerminalScrollbackStoredBytesDurableSync({
        ref: modelRef,
        data: request.modelData,
        storage: context.runtime.terminalScrollbackSnapshotStorage
      })
    }
    if (ref !== modelRef) {
      const previousRefs = layout?.scrollbackRefsByLeafId
      layout.scrollbackRefsByLeafId = {
        ...previousRefs,
        [binding.leafId]: modelRef
      }
      try {
        context.runtime.flushOrThrow()
      } catch (error) {
        if (previousRefs) {
          layout.scrollbackRefsByLeafId = previousRefs
        } else {
          delete layout.scrollbackRefsByLeafId
        }
        throw error
      }
    }
    if (
      layout.scrollbackRefsByLeafId?.[binding.leafId] !== modelRef ||
      !terminalScrollbackStoredBytesEqualSync(
        modelRef,
        request.modelData,
        context.runtime.terminalScrollbackSnapshotStorage
      )
    ) {
      throw new Error('pty_ownership_transfer_model_checkpoint_unverified')
    }
  }
}

export function installPtyOwnershipTransferSurfacePersistenceContext(
  target: object,
  source: PtyOwnershipTransferSurfacePersistence
): void {
  Object.defineProperty(target, surfacePersistenceContext, {
    value: source[surfacePersistenceContext]
  })
}

export function ownershipTransferSurfaceOwnerKey(workspaceKey: string): string {
  const scope = parseWorkspaceKey(workspaceKey)
  if (!scope) {
    throw new Error('pty_ownership_transfer_workspace_invalid')
  }
  return scope.type === 'worktree' ? scope.worktreeId : folderWorkspaceKey(scope.folderWorkspaceId)
}

function ownershipTransferSurfaceBaseline(
  request: PtyOwnershipTransferDestinationPublicationRequest
): string {
  const seed = request.initialModelSnapshot
  return seed
    ? `${seed.modelData}${seed.restoreMetadata.pendingEscapeTailAnsi ?? ''}`
    : request.frames.map((frame) => frame.data).join('')
}
