import process from 'node:process'

export function emulatorControlRuntime(
  pairingRuntime,
  userDataPath = process.env.ORCA_E2E_MOBILE_EMULATOR_CONTROL_USER_DATA_PATH
) {
  if (!userDataPath) {
    return pairingRuntime
  }
  return {
    ...pairingRuntime,
    env: {
      ...(pairingRuntime?.env ?? process.env),
      ORCA_DEV_USER_DATA_PATH: userDataPath,
      ORCA_USER_DATA_PATH: userDataPath
    }
  }
}
