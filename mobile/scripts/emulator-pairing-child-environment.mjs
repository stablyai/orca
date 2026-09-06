export function createEmulatorPairingChildEnvironment({
  inheritedEnvironment,
  environment,
  userData,
  homeDir
}) {
  const childEnvironment = {
    ...inheritedEnvironment,
    ...environment,
    ORCA_DEV_USER_DATA_PATH: userData,
    ORCA_E2E_USER_DATA_DIR: userData,
    ORCA_E2E_HOME_DIR: homeDir,
    HOME: homeDir,
    USERPROFILE: homeDir
  }
  // Keep the disposable home from importing the developer's real agent histories.
  delete childEnvironment.CODEX_HOME
  delete childEnvironment.ORCA_CODEX_HOME
  return childEnvironment
}
