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
  try {
    await initializeReadyFoundation()
    await initializeReadyRuntimeServices()
    // Window creation can proceed while translations and the native menu initialize.
    const i18nAndMenuReady = initializeMainProcessI18nAndMenu()
    state.mainProcessI18nReady = i18nAndMenuReady.catch(() => {})
    // Join both branches before cleanup can close the profile writer.
    const results = await Promise.allSettled([
      i18nAndMenuReady,
      initializeMainProcessRuntimeLaunch(options)
    ])
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason
      }
    }
  } catch (error) {
    // Startup now exits after failure; reopening would use a closing profile writer.
    state.desktopActivationGate = null
    try {
      await state.store?.freezeWritesAsync()
      state.profileStateAdmission?.release()
      state.profileStateAdmission = undefined
    } catch (closeError) {
      console.error(
        '[persistence] Failed to close profile persistence after startup failure:',
        closeError
      )
    }
    throw error
  }
}
