import type { Store } from '../../persistence/loading-store/store'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

export const NOTEBOOK_IPC_CHANNELS = [
  'notebook:listPythonEnvironments',
  'notebook:describePython',
  'notebook:startKernel',
  'notebook:installIpykernel',
  'notebook:createVenv',
  'notebook:execute',
  'notebook:interrupt',
  'notebook:shutdownKernel'
] as const

export const PET_IPC_CHANNELS = [
  'pet:import',
  'pet:importPetBundle',
  'pet:read',
  'pet:delete'
] as const

export const ORCA_UNINSTALL_IPC_CHANNELS = [
  'orcaUninstall:getPlan',
  'orcaUninstall:runStep',
  'orcaUninstall:finish'
] as const

export const BITBUCKET_IPC_CHANNELS = [
  'bitbucket:connect',
  'bitbucket:disconnect',
  'bitbucket:status'
] as const

export const EXPORT_IPC_CHANNELS = ['export:html-to-pdf'] as const
export const FEEDBACK_IPC_CHANNELS = ['feedback:submit'] as const
export const LINK_PREVIEW_IPC_CHANNELS = ['linkPreview:get'] as const

export function registerLazyRareIpcHandlers(store: Store): void {
  registerLazyIpcHandleGroup(ORCA_UNINSTALL_IPC_CHANNELS, async (ipc) => {
    const { registerOrcaUninstallHandlers } = await import('../orca-uninstall')
    registerOrcaUninstallHandlers(store, ipc)
  })
  registerLazyIpcHandleGroup(BITBUCKET_IPC_CHANNELS, async (ipc) => {
    const { registerBitbucketHandlers } = await import('../source-control/bitbucket')
    registerBitbucketHandlers(ipc)
  })
  registerLazyIpcHandleGroup(FEEDBACK_IPC_CHANNELS, async (ipc) => {
    const { registerFeedbackHandlers } = await import('../feedback/feedback')
    registerFeedbackHandlers(ipc)
  })
  registerLazyIpcHandleGroup(EXPORT_IPC_CHANNELS, async (ipc) => {
    const { registerExportHandlers } = await import('../export')
    registerExportHandlers(ipc)
  })
  registerLazyIpcHandleGroup(NOTEBOOK_IPC_CHANNELS, async (ipc) => {
    const { registerNotebookHandlers } = await import('../notebook')
    registerNotebookHandlers(store, ipc)
  })
  registerLazyIpcHandleGroup(PET_IPC_CHANNELS, async (ipc) => {
    const { registerPetHandlers } = await import('../pets/pet')
    registerPetHandlers(ipc)
  })
  registerLazyIpcHandleGroup(LINK_PREVIEW_IPC_CHANNELS, async (ipc) => {
    const { registerLinkPreviewHandlers } = await import('../link-preview')
    registerLinkPreviewHandlers(ipc)
  })
}
