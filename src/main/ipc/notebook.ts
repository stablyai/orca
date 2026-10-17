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
type OwnedKernel = { kernel: NotebookKernel; producerId: string }
const kernelsByOwner = new Map<WebContents, Map<string, OwnedKernel>>()
const startCancellations = createSenderScopedRequestCancellations()
const startsByOwner = new WeakMap<WebContents, Map<string, Map<AbortController, string>>>()

function cancelPendingStarts(owner: WebContents, filePath: string, producerId?: string): void {
  const starts = startsByOwner.get(owner)
  const pending = starts?.get(filePath)
  for (const [controller, id] of pending ?? []) {
    if (producerId === undefined || id === producerId) {
      controller.abort()
      pending?.delete(controller)
    }
  }
  if (pending?.size === 0) {
    starts?.delete(filePath)
  }
}

// Why: a reloaded, crashed or closed renderer has lost its sessions, so its kernels go with it.
function kernelsOf(owner: WebContents): Map<string, OwnedKernel> {
  let kernels = kernelsByOwner.get(owner)
  if (!kernels) {
    const owned = new Map<string, OwnedKernel>()
    const stopAll = (): void => {
      for (const { kernel } of owned.values()) {
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
    async (
      event,
      args: { filePath: string; python: string; producerId: string }
    ): Promise<KernelStartResult> => {
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
      const starts = startsByOwner.get(owner) ?? new Map<string, Map<AbortController, string>>()
      startsByOwner.set(owner, starts)
      const pending = starts.get(args.filePath) ?? new Map<AbortController, string>()
      starts.set(args.filePath, pending)
      for (const [older, producerId] of pending) {
        if (producerId !== args.producerId) {
          older.abort()
        }
      }
      pending.set(controller, args.producerId)
      try {
        // Why the real file's folder: relative imports and data paths resolve as on disk, even when
        // the notebook was opened through a link.
        const cwd = dirname(await realpath(await resolveUserNamedRegularFile(args.filePath, store)))
        if (controller.signal.aborted || owner.isDestroyed()) {
          return { status: 'failed', detail: 'The notebook closed before its kernel started.' }
        }
        const kernels = kernelsOf(owner)
        kernels.get(args.filePath)?.kernel.shutdown()
        const { kernel, ready, exited } = startNotebookKernel({
          python: args.python,
          cwd,
          onFrame: (frame) => {
            if (!owner.isDestroyed()) {
              owner.send('notebook:kernelFrame', {
                filePath: args.filePath,
                producerId: args.producerId,
                frame
              } satisfies KernelFrameEvent)
            }
          }
        })
        kernels.set(args.filePath, { kernel, producerId: args.producerId })
        void exited.then(() => {
          if (kernels.get(args.filePath)?.kernel === kernel) {
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
    kernelsOf(event.sender).get(args.filePath)?.kernel.execute(args.code)
  })

  ipcMain.handle('notebook:interrupt', (event, args: { filePath: string }): void => {
    kernelsOf(event.sender).get(args.filePath)?.kernel.interrupt()
  })

  ipcMain.handle(
    'notebook:shutdownKernel',
    (event, args: { filePath: string; producerId?: string; drain?: boolean }): void => {
      cancelPendingStarts(event.sender, args.filePath, args.producerId)
      const kernels = kernelsOf(event.sender)
      const owned = kernels.get(args.filePath)
      if (owned && (args.producerId === undefined || owned.producerId === args.producerId)) {
        try {
          owned.kernel.shutdown(args.drain === true)
        } finally {
          kernels.delete(args.filePath)
        }
      } else if (args.drain && args.producerId && !event.sender.isDestroyed()) {
        event.sender.send('notebook:kernelFrame', {
          filePath: args.filePath,
          producerId: args.producerId,
          frame: { type: 'stopped' }
        } satisfies KernelFrameEvent)
      }
    }
  )
}
