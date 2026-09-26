import { initializeMainProcessI18nAndMenu } from './main-process-i18n-menu'
import { mainProcessState as state } from './main-process-state'
import { initializeReadyFoundation } from './main-process-ready-foundation'
import { initializeReadyRuntimeServices } from './main-process-ready-runtime'
import { releaseDesktopActivationAfter } from './serve-desktop-activation'
import {
  initializeMainProcessRuntimeLaunch,
  type MainProcessRuntimeLaunchOptions
} from './main-process-runtime-launch'

/** Runs the ready-phase composition in the same dependency order as the legacy entry point. */
export async function initializeMainProcessReady(
  launchOptions: MainProcessRuntimeLaunchOptions
): Promise<void> {
  const options: MainProcessRuntimeLaunchOptions = {
    ...launchOptions,
    openMainWindow: releaseDesktopActivationAfter(
      state.desktopActivationGate,
      launchOptions.openMainWindow
    )
  }
  await initializeReadyFoundation().catch(releaseDesktopActivationOnFailure)
  await initializeReadyRuntimeServices().catch(releaseDesktopActivationOnFailure)
  // Why concurrent: window creation reads no translated string and no menu item, and both the
  // native menu and the tray only become reachable once the window shows — so serializing them
  // ahead of openMainWindow only delayed the renderer (8 ms in English, more for a lazy locale).
  const i18nAndMenuReady = initializeMainProcessI18nAndMenu()
  state.mainProcessI18nReady = i18nAndMenuReady.catch(() => {})
  await Promise.all([
    i18nAndMenuReady,
    initializeMainProcessRuntimeLaunch(options).catch(releaseDesktopActivationOnFailure)
  ])
}

function releaseDesktopActivationOnFailure(error: unknown): never {
  // Keep later opens possible after a failed phase; serve promotion still fails closed.
  if (!state.isServeMode) {
    state.desktopActivationGate?.markReady()
  }
  throw error
}
