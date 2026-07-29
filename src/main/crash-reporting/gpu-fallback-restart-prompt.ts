import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'

export type GpuFallbackRestartDecision = 'restart' | 'continue'

const GPU_FALLBACK_RESTART_OPTIONS: MessageBoxOptions = {
  type: 'warning',
  buttons: ['Restart with Software Rendering', 'Keep Running'],
  defaultId: 0,
  cancelId: 1,
  title: 'Restart Orca?',
  message: "Orca's graphics process has crashed repeatedly.",
  detail:
    'Restart to switch to software rendering and reduce the chance of the app window crashing. If you keep running, Orca may become unstable.'
}

export async function promptForGpuFallbackRestart(
  parentWindow?: BrowserWindow
): Promise<GpuFallbackRestartDecision> {
  const { response } = parentWindow
    ? await dialog.showMessageBox(parentWindow, GPU_FALLBACK_RESTART_OPTIONS)
    : await dialog.showMessageBox(GPU_FALLBACK_RESTART_OPTIONS)
  return response === 0 ? 'restart' : 'continue'
}
