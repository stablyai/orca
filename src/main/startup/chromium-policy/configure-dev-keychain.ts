import { app } from 'electron'

export function configureDevKeychain(): void {
  if (
    process.platform === 'darwin' &&
    !app.isPackaged &&
    process.env.ORCA_DEV_USE_KEYCHAIN !== '1'
  ) {
    // Fresh dev bundles otherwise block on hidden macOS Keychain prompts.
    app.commandLine.appendSwitch('use-mock-keychain')
  }
}

export function usesMockKeychain(): boolean {
  return process.platform === 'darwin' && app.commandLine.hasSwitch('use-mock-keychain')
}
