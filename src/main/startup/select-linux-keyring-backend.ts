import { app } from 'electron'
import { resolveLinuxPasswordStore } from './linux-keyring-backend-selection'
import { probeSecretServiceCollection } from './linux-secret-service-probe'

/** Select Linux credentials before ready/safeStorage fixes os_crypt config; otherwise the requested backend is ignored (#21827). */
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
  // Log actual backend changes only; ordinary no-op launches would add noise.
  log(`[secrets] selected --password-store=${decision.store}: ${decision.reason}`)
}
