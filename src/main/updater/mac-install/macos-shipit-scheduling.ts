import { createRequire } from 'node:module'
import { join } from 'node:path'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'

const requireNative = createRequire(import.meta.url)
let configured = false

/** Keep Squirrel's native install and verification; change only its launchd resource class. */
export function configureMacShipItScheduling(): void {
  if (process.platform !== 'darwin' || configured) {
    return
  }
  let reason = 'load_failed'
  try {
    const addon: unknown = requireNative(join(process.resourcesPath, 'orca_shipit_scheduling.node'))
    reason = 'missing_export'
    if (
      typeof addon !== 'object' ||
      addon === null ||
      !('configure' in addon) ||
      typeof addon.configure !== 'function'
    ) {
      throw new Error('Squirrel installer scheduling is unavailable')
    }
    reason = 'configure_failed'
    const result = addon.configure()
    reason = 'contract_mismatch'
    if (result !== true) {
      throw new Error('Squirrel installer scheduling is unavailable')
    }
    configured = true
    recordUpdaterLifecycle('macos_installer_scheduling_configured', { processType: 'Interactive' })
  } catch (error) {
    // An Electron API change must leave the native updater usable.
    recordUpdaterLifecycle(
      'macos_installer_scheduling_unavailable',
      { reason, errorType: error instanceof Error ? error.name : typeof error },
      { level: 'warn', message: 'Could not configure macOS installer scheduling' }
    )
  }
}
