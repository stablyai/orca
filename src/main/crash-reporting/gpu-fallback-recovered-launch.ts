import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'

export type GpuFallbackRecoveredLaunchDecision = 'keep-safe' | 'retry-hardware'

const GPU_FALLBACK_RECOVERED_LAUNCH_OPTIONS: MessageBoxOptions = {
  type: 'info',
  buttons: ['Keep Safe Graphics Mode', 'Try Hardware Acceleration'],
  defaultId: 0,
  cancelId: 0,
  title: 'Safe Graphics Mode is Active',
  message: 'Orca recovered in Safe Graphics Mode.',
  detail:
    'Safe Graphics Mode was enabled after repeated graphics crashes. Keep it for stability, or restart and try hardware acceleration again.'
}

export async function promptForGpuFallbackRecoveredLaunch(
  parentWindow?: BrowserWindow
): Promise<GpuFallbackRecoveredLaunchDecision> {
  const { response } = parentWindow
    ? await dialog.showMessageBox(parentWindow, GPU_FALLBACK_RECOVERED_LAUNCH_OPTIONS)
    : await dialog.showMessageBox(GPU_FALLBACK_RECOVERED_LAUNCH_OPTIONS)
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
