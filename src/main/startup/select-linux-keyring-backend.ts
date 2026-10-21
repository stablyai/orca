import { app } from 'electron'
import { resolveLinuxPasswordStore } from './linux-keyring-backend-selection'
import { probeSecretServiceCollection } from './linux-secret-service-probe'

/**
 * Name Chromium's credential backend when its own detection would give up (#21827).
 *
 * Must run before Electron builds its os_crypt config, which it does while starting
 * browser main parts — so before app ready, and before anything touches safeStorage.
 */
export function selectLinuxKeyringBackend(
  log: (message: string) => void = (message) => console.log(message)
): void {
  if (process.platform !== 'linux') {
    return
  }
  const decision = resolveLinuxPasswordStore({
    env: process.env,
    passwordStoreAlreadySelected:
      app.commandLine.hasSwitch('password-store') ||
      process.argv.some((argument) => argument.startsWith('--password-store')),
    probeCollection: probeSecretServiceCollection
  })
  if (!decision.store) {
    return
  }
  app.commandLine.appendSwitch('password-store', decision.store)
  // Why logged only when it fires: the no-op cases are every ordinary Linux launch, and
  // this line is the only record that the app changed its own credential backend.
  log(`[secrets] selected --password-store=${decision.store}: ${decision.reason}`)
}
