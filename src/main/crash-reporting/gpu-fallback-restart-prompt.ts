import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { translateMain } from '../i18n/main-i18n'

export type GpuFallbackRestartDecision = 'restart' | 'continue'

export function gpuFallbackRestartOptions(): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: [
      translateMain('gpuFallback.restartPrompt.restartButton', 'Restart in Safe Graphics Mode'),
      translateMain('gpuFallback.restartPrompt.keepRunningButton', 'Keep Running')
    ],
    defaultId: 0,
    cancelId: 1,
    title: translateMain('gpuFallback.restartPrompt.title', 'Restart Orca in Safe Graphics Mode?'),
    message: translateMain(
      'gpuFallback.restartPrompt.message',
      "Orca's graphics process has crashed repeatedly."
    ),
    detail: translateMain(
      'gpuFallback.restartPrompt.detail',
      'Safe graphics mode disables hardware acceleration and WebGL for this Orca version. Terminals and 3D content may render more slowly. Keep Running leaves graphics settings unchanged.'
    )
  }
}

export async function promptForGpuFallbackRestart(
  parentWindow?: BrowserWindow
): Promise<GpuFallbackRestartDecision> {
  const options = gpuFallbackRestartOptions()
  const { response } = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options)
  return response === 0 ? 'restart' : 'continue'
}
