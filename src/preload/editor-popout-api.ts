import type { IpcRenderer } from 'electron'
import { admitEditorPopoutOpenRequest, type EditorPopoutOpenRequest } from '../shared/editor-popout'
import {
  richMarkdownContextMenuCommandChannel,
  richMarkdownContextMenuTargetChannel,
  type RichMarkdownContextMenuCommandPayload,
  type RichMarkdownContextMenuTableTarget
} from '../shared/rich-markdown-context-menu'

type EditorPopoutIpc = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send' | 'sendSync'>

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
  if (request.document.runtimeEnvironmentId) {
    throw new Error('Runtime-owned detached editors cannot use host filesystem IPC.')
  }
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
      reportReady: (): Promise<unknown> => ipc.invoke('editorPopout:ready'),
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
    },
    settings: {
      get: (): Promise<unknown> => ipc.invoke('settings:get'),
      getSync: (): unknown => ipc.sendSync('settings:get-sync'),
      onChanged: (callback: (updates: Record<string, unknown>) => void): (() => void) => {
        const listener = (
          _event: Electron.IpcRendererEvent,
          updates: Record<string, unknown>
        ): void => callback(updates)
        ipc.on('settings:changed', listener)
        return () => ipc.removeListener('settings:changed', listener)
      }
    },
    ui: {
      readClipboardText: (_options?: unknown): Promise<string> => Promise.resolve(''),
      writeClipboardText: (text: string): Promise<unknown> =>
        ipc.invoke('clipboard:writeText', text),
      saveClipboardImageAsTempFile: (_args?: {
        connectionId?: string | null
        runtimeEnvironmentId?: string | null
      }): Promise<null> => Promise.resolve(null),
      setMarkdownEditorFocused: (focused: boolean): void => {
        ipc.send('ui:setMarkdownEditorFocused', focused)
      },
      setRichMarkdownContextMenuTarget: (
        target: RichMarkdownContextMenuTableTarget | null
      ): void => {
        ipc.send(richMarkdownContextMenuTargetChannel, target)
      },
      onRichMarkdownContextCommand: (
        callback: (payload: RichMarkdownContextMenuCommandPayload) => void
      ): (() => void) => {
        const listener = (
          _event: Electron.IpcRendererEvent,
          payload: RichMarkdownContextMenuCommandPayload
        ): void => callback(payload)
        ipc.on(richMarkdownContextMenuCommandChannel, listener)
        return () => ipc.removeListener(richMarkdownContextMenuCommandChannel, listener)
      }
    },
    shell: {
      pathExists: (_filePath: string): Promise<boolean> => Promise.resolve(false),
      openFileUri: (_uri: string): Promise<void> => Promise.resolve(),
      pickImage: (): Promise<null> => Promise.resolve(null)
    }
  }
}
