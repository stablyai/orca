import { app } from 'electron'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import type { Store } from '../persistence/loading-store/store'
import { CliInstaller } from '../cli/cli-installer'
import { runLocalCliRegistrationOperation } from '../ipc/cli'

// Leave startup alone; registration may spawn PowerShell or show the macOS admin prompt.
const ZOTZ_CLI_REGISTRATION_DELAY_MS = 15_000

/** Missing, stale, or off the PATH: what a fresh install or an update must repair. */
export function needsZotzCliRegistration(status: CliInstallStatus): boolean {
  if (!status.supported) {
    return false
  }
  return (
    status.state === 'not_installed' ||
    status.state === 'stale' ||
    (status.state === 'installed' && status.pathConfigured === false)
  )
}

/** After each install or update, registers the `zotz` command if it is missing. */
export function scheduleZotzCliRegistration(store: Store): void {
  const version = app.getVersion()
  if (!app.isPackaged || store.getSettings().zotzCliRegisteredVersion === version) {
    return
  }
  setTimeout(() => {
    void runLocalCliRegistrationOperation(async () => {
      const installer = new CliInstaller()
      const status = await installer.getStatus()
      const result = needsZotzCliRegistration(status) ? await installer.install() : status
      console.log(`[zotz] CLI ${result.commandName}: ${result.state}`)
    })
      .catch((error) =>
        console.warn(
          '[zotz] CLI registration skipped:',
          error instanceof Error ? error.message : error
        )
      )
      // A cancelled admin prompt or a conflict waits for the next update or Settings → CLI.
      .finally(() => store.updateSettings({ zotzCliRegisteredVersion: version }))
  }, ZOTZ_CLI_REGISTRATION_DELAY_MS).unref?.()
}
