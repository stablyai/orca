import { initializeMainProcessI18nAndMenu } from './main-process-i18n-menu'
import { initializeReadyFoundation } from './main-process-ready-foundation'
import { initializeReadyRuntimeServices } from './main-process-ready-runtime'
import {
  initializeMainProcessRuntimeLaunch,
  type MainProcessRuntimeLaunchOptions
} from './main-process-runtime-launch'

/** Runs the ready-phase composition in the same dependency order as the legacy entry point. */
export async function initializeMainProcessReady(
  options: MainProcessRuntimeLaunchOptions
): Promise<void> {
  await initializeReadyFoundation()
  await initializeReadyRuntimeServices()
  await initializeMainProcessI18nAndMenu()
  await initializeMainProcessRuntimeLaunch(options)
}
