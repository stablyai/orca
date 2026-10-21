import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import {
  resolveDesktopAuthorizedPath,
  resolveUserNamedRegularFile
} from './local-file-access-resolution'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'
import { startNotebookKernel, type NotebookKernel } from '../notebook/notebook-kernel'
import {
  createNotebookVenv,
  describePython,
  installIpykernel,
  listPythonEnvironments
} from '../notebook/python-environments'
import { notebookVenvParent } from '../../shared/notebook-venv-location'
import type {
  CreateVenvResult,
  KernelFrameEvent,
  KernelStartResult,
  PythonEnvironment,
  PythonEnvironments
} from '../../shared/notebook-kernel-types'

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

// Why: a reloaded, crashed or closed renderer has lost its sessions, so its kernels go with it.
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

// Why the notebook path is user-named: it is an open tab, and it only picks the kernel's cwd and
// the venv folder. Inside a project it resolves to the real file, so the cwd is its real folder.
export function registerNotebookHandlers(store: Store): void {
  ipcMain.handle(
    'notebook:listPythonEnvironments',
    async (
      _event,
      args: { filePath: string; rootPath: string | null; runWorkspaceInterpreters: boolean }
    ): Promise<PythonEnvironments> => {
      await resolveUserNamedRegularFile(args.filePath, store)
      // Why the unresolved path: rootPath is in the same (possibly symlinked) form, e.g. /tmp.
      return listPythonEnvironments(args.filePath, args.rootPath, {
        runWorkspaceInterpreters: args.runWorkspaceInterpreters === true
      })
    }
  )

  ipcMain.handle(
    'notebook:describePython',
    (_event, args: { path: string }): Promise<PythonEnvironment | null> => describePython(args.path)
  )

  ipcMain.handle(
    'notebook:startKernel',
    async (event, args: { filePath: string; python: string }): Promise<KernelStartResult> => {
      const owner = event.sender
      if (owner.isDestroyed()) {
        return { status: 'failed', detail: 'The notebook closed before its kernel started.' }
      }
      // Each start stays independent until the notebook or issuing document closes.
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
        // Why the real file's folder: relative imports and data paths resolve as on disk, even when
        // the notebook was opened through a link.
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

  ipcMain.handle(
    'notebook:installIpykernel',
    (_event, args: { python: string }): Promise<{ ok: boolean; detail: string }> =>
      installIpykernel(args.python)
  )

  ipcMain.handle(
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

  ipcMain.handle('notebook:execute', (event, args: { filePath: string; code: string }): void => {
    kernelsOf(event.sender).get(args.filePath)?.execute(args.code)
  })

  ipcMain.handle('notebook:interrupt', (event, args: { filePath: string }): void => {
    kernelsOf(event.sender).get(args.filePath)?.interrupt()
  })

  ipcMain.handle('notebook:shutdownKernel', (event, args: { filePath: string }): void => {
    cancelPendingStarts(event.sender, args.filePath)
    const kernels = kernelsOf(event.sender)
    kernels.get(args.filePath)?.shutdown()
    kernels.delete(args.filePath)
  })
}
