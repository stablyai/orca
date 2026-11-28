import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ipcMain, type WebContents } from 'electron'
import type { IpcHandleRegistrar } from './lazy-ipc-handle-group'
import type { Store } from '../persistence/loading-store/store'
import {
  resolveDesktopAuthorizedPath,
  resolveUserNamedRegularFile
} from './filesystem/access/local-file-access-resolution'
import { createSenderScopedRequestCancellations } from './renderer-requests/sender-scoped-request-cancellation'
import { startNotebookKernel, type NotebookKernel } from '../notebook/notebook-kernel'
import {
  createNotebookVenv,
  describePython,
  installIpykernel,
  listPythonEnvironments
} from '../notebook/python-environments'
import { notebookVenvParent } from '../../shared/editor/notebooks/notebook-venv-location'
import type {
  CreateVenvResult,
  KernelFrameEvent,
  KernelStartResult,
  PythonEnvironment,
  PythonEnvironments
} from '../../shared/editor/notebooks/notebook-kernel-types'

/** Each renderer document's kernels, by notebook file. */
const kernelsByOwner = new Map<WebContents, Map<string, NotebookKernel>>()
const startCancellations = createSenderScopedRequestCancellations()
const startsByOwner = new WeakMap<WebContents, Map<string, Set<AbortController>>>()

function cancelPendingStarts(owner: WebContents, filePath: string): void {
  const starts = startsByOwner.get(owner)
  const pending = starts?.get(filePath)
  starts?.delete(filePath)
  for (const controller of pending ?? []) {
    controller.abort()
  }
}

// Renderer page teardown must also retire its notebook kernels.
function kernelsOf(owner: WebContents): Map<string, NotebookKernel> {
  let kernels = kernelsByOwner.get(owner)
  if (!kernels) {
    const owned = new Map<string, NotebookKernel>()
    const stopAll = (): void => {
      for (const kernel of owned.values()) {
        kernel.shutdown()
      }
      owned.clear()
    }
    owner.on('did-navigate', stopAll)
    owner.on('render-process-gone', stopAll)
    owner.once('destroyed', () => {
      stopAll()
      kernelsByOwner.delete(owner)
    })
    kernelsByOwner.set(owner, owned)
    kernels = owned
  }
  return kernels
}

// Open notebook paths select cwd/venv; project paths canonicalize to their real file.
export function registerNotebookHandlers(store: Store, ipc: IpcHandleRegistrar = ipcMain): void {
  ipc.handle(
    'notebook:listPythonEnvironments',
    async (
      _event,
      args: { filePath: string; rootPath: string | null; runWorkspaceInterpreters: boolean }
    ): Promise<PythonEnvironments> => {
      await resolveUserNamedRegularFile(args.filePath, store)
      // Environment listing needs the same unresolved spelling as rootPath.
      return listPythonEnvironments(args.filePath, args.rootPath, {
        runWorkspaceInterpreters: args.runWorkspaceInterpreters === true
      })
    }
  )

  ipc.handle(
    'notebook:describePython',
    (_event, args: { path: string }): Promise<PythonEnvironment | null> => describePython(args.path)
  )

  ipc.handle(
    'notebook:startKernel',
    async (event, args: { filePath: string; python: string }): Promise<KernelStartResult> => {
      const owner = event.sender
      if (owner.isDestroyed()) {
        return { status: 'failed', detail: 'The notebook closed before its kernel started.' }
      }
      const requestToken = randomUUID()
      const controller = startCancellations.begin(event, requestToken)
      if (!controller) {
        return { status: 'failed', detail: 'The notebook closed before its kernel started.' }
      }
      const starts = startsByOwner.get(owner) ?? new Map<string, Set<AbortController>>()
      startsByOwner.set(owner, starts)
      const pending = starts.get(args.filePath) ?? new Set<AbortController>()
      starts.set(args.filePath, pending)
      pending.add(controller)
      try {
        // Use the real notebook folder so relative imports and data paths follow disk layout.
        const cwd = dirname(await realpath(await resolveUserNamedRegularFile(args.filePath, store)))
        if (controller.signal.aborted || owner.isDestroyed()) {
          return { status: 'failed', detail: 'The notebook closed before its kernel started.' }
        }
        const kernels = kernelsOf(owner)
        kernels.get(args.filePath)?.shutdown()
        const { kernel, ready, exited } = startNotebookKernel({
          python: args.python,
          cwd,
          onFrame: (frame) => {
            if (!owner.isDestroyed()) {
              owner.send('notebook:kernelFrame', {
                filePath: args.filePath,
                frame
              } satisfies KernelFrameEvent)
            }
          }
        })
        kernels.set(args.filePath, kernel)
        void exited.then(() => {
          if (kernels.get(args.filePath) === kernel) {
            kernels.delete(args.filePath)
          }
        })
        return await ready
      } finally {
        pending.delete(controller)
        if (pending.size === 0 && starts.get(args.filePath) === pending) {
          starts.delete(args.filePath)
        }
        startCancellations.finish(event, requestToken, controller)
      }
    }
  )

  ipc.handle(
    'notebook:installIpykernel',
    (_event, args: { python: string }): Promise<{ ok: boolean; detail: string }> =>
      installIpykernel(args.python)
  )

  ipc.handle(
    'notebook:createVenv',
    async (
      _event,
      args: { filePath: string; rootPath: string | null; python: string }
    ): Promise<CreateVenvResult> => {
      await resolveUserNamedRegularFile(args.filePath, store)
      if (args.rootPath) {
        await resolveDesktopAuthorizedPath(args.rootPath, store)
      }
      return createNotebookVenv(args.python, notebookVenvParent(args.filePath, args.rootPath))
    }
  )

  ipc.handle('notebook:execute', (event, args: { filePath: string; code: string }): void => {
    kernelsOf(event.sender).get(args.filePath)?.execute(args.code)
  })

  ipc.handle('notebook:interrupt', (event, args: { filePath: string }): void => {
    kernelsOf(event.sender).get(args.filePath)?.interrupt()
  })

  ipc.handle('notebook:shutdownKernel', (event, args: { filePath: string }): void => {
    cancelPendingStarts(event.sender, args.filePath)
    const kernels = kernelsOf(event.sender)
    kernels.get(args.filePath)?.shutdown()
    kernels.delete(args.filePath)
  })
}
