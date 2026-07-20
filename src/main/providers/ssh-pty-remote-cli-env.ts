import { seedPowerlevel10kWizardEnv } from '../pty/powerlevel10k-wizard-env'

export type RemoteCliBridgeEnv = {
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  pathDelimiter?: ':' | ';'
}

export function buildSshPtyRemoteCliEnv(
  env: Record<string, string> | undefined,
  remoteCliBridgeEnv: RemoteCliBridgeEnv | undefined,
  envToDelete?: readonly string[]
): Record<string, string> {
  const merged = { ...env }
  if (remoteCliBridgeEnv) {
    const pathDelimiter = remoteCliBridgeEnv.pathDelimiter ?? ':'
    const pathKey = merged.PATH !== undefined ? 'PATH' : merged.Path !== undefined ? 'Path' : null
    if (pathKey) {
      const pathValue = merged[pathKey] ?? ''
      merged[pathKey] = pathValue.split(pathDelimiter).includes(remoteCliBridgeEnv.binDir)
        ? pathValue
        : pathValue
          ? `${remoteCliBridgeEnv.binDir}${pathDelimiter}${pathValue}`
          : remoteCliBridgeEnv.binDir
    }
    merged.ORCA_REMOTE_CLI_BIN_DIR = remoteCliBridgeEnv.binDir
    merged.ORCA_RELAY_DIR = remoteCliBridgeEnv.relayDir
    merged.ORCA_RELAY_NODE_PATH = remoteCliBridgeEnv.nodePath
    merged.ORCA_RELAY_SOCKET_PATH = remoteCliBridgeEnv.sockPath
  }
  // Why: managed defaults and augmentations cannot resurrect values the caller explicitly removed.
  for (const key of envToDelete ?? []) {
    delete merged[key]
  }
  seedPowerlevel10kWizardEnv(merged, { envToDelete })
  return merged
}
