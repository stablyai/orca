import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { translateMain } from '../i18n/main-i18n'

export type GpuFallbackRecoveredLaunchDecision = 'keep-safe' | 'retry-hardware'

export function gpuFallbackRecoveredLaunchOptions(): MessageBoxOptions {
  return {
    type: 'info',
    buttons: [
      translateMain('gpuFallback.recoveredLaunch.keepSafeButton', 'Keep Safe Graphics Mode'),
      translateMain('gpuFallback.recoveredLaunch.tryHardwareButton', 'Try Hardware Acceleration')
    ],
    defaultId: 0,
    cancelId: 0,
    title: translateMain('gpuFallback.recoveredLaunch.title', 'Safe Graphics Mode is Active'),
    message: translateMain(
      'gpuFallback.recoveredLaunch.message',
      'Orca recovered in Safe Graphics Mode.'
    ),
    detail: translateMain(
      'gpuFallback.recoveredLaunch.detail',
      'Safe Graphics Mode was enabled after repeated graphics crashes. Keep it for stability, or restart and try hardware acceleration again.'
    )
  }
}

export async function promptForGpuFallbackRecoveredLaunch(
  parentWindow?: BrowserWindow
): Promise<GpuFallbackRecoveredLaunchDecision> {
  const options = gpuFallbackRecoveredLaunchOptions()
  const { response } = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options)
  return response === 1 ? 'retry-hardware' : 'keep-safe'
}

export type GpuFallbackRecoveredLaunchHandlers = {
  isQuitting: () => boolean
  prompt: () => Promise<GpuFallbackRecoveredLaunchDecision>
  confirmSafeGraphics: () => void
  clearSafeGraphics: () => void
  onPromptFailed: (error: unknown) => void
  onSafeGraphicsKept: () => void
  restartWithHardware: () => void
}

/** Resolves consent after an unanswered crash-time prompt recovered into safe graphics. */
export async function handleGpuFallbackRecoveredLaunch(
  handlers: GpuFallbackRecoveredLaunchHandlers
): Promise<void> {
  let decision: GpuFallbackRecoveredLaunchDecision
  try {
    decision = await handlers.prompt()
  } catch (error) {
    handlers.onPromptFailed(error)
    return
  }
  if (handlers.isQuitting()) {
    return
  }
  if (decision === 'retry-hardware') {
    handlers.clearSafeGraphics()
    handlers.restartWithHardware()
    return
  }
  handlers.confirmSafeGraphics()
  handlers.onSafeGraphicsKept()
}
