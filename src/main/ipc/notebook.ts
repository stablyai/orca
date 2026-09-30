import { dirname } from 'node:path'
import { ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'
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

export function registerNotebookHandlers(store: Store): void {
  ipcMain.handle(
    'notebook:listPythonEnvironments',
    async (
      _event,
      args: { filePath: string; rootPath: string | null; runWorkspaceInterpreters: boolean }
    ): Promise<PythonEnvironments> => {
      await resolveAuthorizedPath(args.filePath, store)
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
      // Why: run from the notebook's folder so relative imports and data paths resolve as on disk.
      const cwd = dirname(await resolveAuthorizedPath(args.filePath, store))
      const owner = event.sender
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
      return ready
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
      await resolveAuthorizedPath(args.filePath, store)
      if (args.rootPath) {
        await resolveAuthorizedPath(args.rootPath, store)
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
    const kernels = kernelsOf(event.sender)
    kernels.get(args.filePath)?.shutdown()
    kernels.delete(args.filePath)
  })
}
