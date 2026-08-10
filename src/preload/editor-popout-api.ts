import type { IpcRenderer } from 'electron'
import { admitEditorPopoutOpenRequest, type EditorPopoutOpenRequest } from '../shared/editor-popout'

type EditorPopoutIpc = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>

type FsReadArgs = {
  filePath: string
  connectionId?: string
  includeLocalLogMetadata?: boolean
}

type FsWriteArgs = {
  filePath: string
  content: string
  connectionId?: string
  expectedExecutionHostId: 'local' | `ssh:${string}`
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExternalSshTargetId?: string
}

type RuntimeCallArgs = {
  selector: string
  method: string
  params?: unknown
  timeoutMs?: number
  expectedEnvironmentPairingRevision?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRequest(request: EditorPopoutOpenRequest | null): EditorPopoutOpenRequest {
  if (!request) {
    throw new Error('Detached editor state is unavailable.')
  }
  return request
}

function assertOwnedFilesystemRequest(
  request: EditorPopoutOpenRequest,
  args: FsReadArgs | FsWriteArgs
): void {
  if (
    args.filePath !== request.document.filePath ||
    args.connectionId !== request.operationContext.connectionId
  ) {
    throw new Error('Detached editor filesystem access is outside the owned document.')
  }
}

function runtimeWorktreeSelector(worktreeId: string): string {
  const trimmed = worktreeId.trim()
  return trimmed.startsWith('id:') ? trimmed : `id:${trimmed}`
}

function assertOwnedRuntimeCall(request: EditorPopoutOpenRequest, args: RuntimeCallArgs): void {
  if (
    !request.document.runtimeEnvironmentId ||
    args.selector !== request.document.runtimeEnvironmentId ||
    args.expectedEnvironmentPairingRevision !==
      request.operationContext.expectedEnvironmentPairingRevision
  ) {
    throw new Error('Detached editor runtime access is outside the owned environment.')
  }
  if (args.method === 'status.get') {
    return
  }
  if (args.method !== 'files.read' && args.method !== 'files.write') {
    throw new Error('Detached editor runtime method is not permitted.')
  }
  if (
    !isRecord(args.params) ||
    args.params.worktree !== runtimeWorktreeSelector(request.document.worktreeId) ||
    args.params.relativePath !== request.document.relativePath ||
    (args.method === 'files.write' && typeof args.params.content !== 'string')
  ) {
    throw new Error('Detached editor runtime access is outside the owned document.')
  }
}

export function createEditorPopoutPreloadApi(ipc: EditorPopoutIpc) {
  let request: EditorPopoutOpenRequest | null = null
  return {
    editorPopout: {
      getState: async (): Promise<EditorPopoutOpenRequest | null> => {
        request = admitEditorPopoutOpenRequest(await ipc.invoke('editorPopout:getState'))
        return request
      },
      setDirty: (dirty: boolean): Promise<unknown> => ipc.invoke('editorPopout:setDirty', dirty),
      reportCloseState: (dirty: boolean): Promise<unknown> =>
        ipc.invoke('editorPopout:reportCloseState', dirty),
      completeSaveAndClose: (saved: boolean): Promise<unknown> =>
        ipc.invoke('editorPopout:completeSaveAndClose', saved),
      onRequestCloseState: (callback: () => void): (() => void) => {
        const listener = (): void => callback()
        ipc.on('editorPopout:requestCloseState', listener)
        return () => ipc.removeListener('editorPopout:requestCloseState', listener)
      },
      onSaveAndClose: (callback: () => void): (() => void) => {
        const listener = (): void => callback()
        ipc.on('editorPopout:saveAndClose', listener)
        return () => ipc.removeListener('editorPopout:saveAndClose', listener)
      }
    },
    fs: {
      readFile: (args: FsReadArgs): Promise<unknown> => {
        assertOwnedFilesystemRequest(requireRequest(request), args)
        return ipc.invoke('fs:readFile', args)
      },
      writeFile: (args: FsWriteArgs): Promise<unknown> => {
        const currentRequest = requireRequest(request)
        assertOwnedFilesystemRequest(currentRequest, args)
        if (
          args.expectedExecutionHostId !==
            currentRequest.operationContext.expectedExecutionHostId ||
          args.expectedSshTargetId !== currentRequest.operationContext.expectedSshTargetId ||
          args.expectedSshConnectionGeneration !==
            currentRequest.operationContext.expectedSshConnectionGeneration ||
          args.expectedExternalSshTargetId !==
            currentRequest.operationContext.expectedExternalSshTargetId
        ) {
          throw new Error('Detached editor write ownership changed.')
        }
        return ipc.invoke('fs:writeFile', args)
      }
    },
    runtimeEnvironments: {
      call: (args: RuntimeCallArgs): Promise<unknown> => {
        assertOwnedRuntimeCall(requireRequest(request), args)
        return ipc.invoke('runtimeEnvironments:call', args)
      }
    }
  }
}
