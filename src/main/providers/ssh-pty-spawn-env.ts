import { seedPowerlevel10kWizardEnv } from '../pty/powerlevel10k-wizard-env'
import type { RemoteCliBridgeEnv } from './ssh-pty-provider-contract'

export function buildSshPtySpawnEnv(args: {
  env: Record<string, string> | undefined
  envToDelete?: readonly string[]
  remoteCliBridgeEnv?: RemoteCliBridgeEnv
}): Record<string, string> {
  const merged = { ...args.env }
  if (args.remoteCliBridgeEnv) {
    const pathDelimiter = args.remoteCliBridgeEnv.pathDelimiter ?? ':'
    const pathKey = merged.PATH !== undefined ? 'PATH' : merged.Path !== undefined ? 'Path' : null
    if (pathKey) {
      // Why: the bin dir must be first, not merely present. Agents resolve
      // `orca` by PATH order, and a host-installed Orca CLI earlier in PATH
      // silently routes worker lifecycle calls to the wrong runtime (#8608).
      const binDir = args.remoteCliBridgeEnv.binDir
      const pathValue = merged[pathKey] ?? ''
      const segments = pathValue ? pathValue.split(pathDelimiter) : []
      merged[pathKey] =
        segments[0] === binDir
          ? pathValue
          : [binDir, ...segments.filter((segment) => segment !== binDir)].join(pathDelimiter)
    }
    merged.ORCA_REMOTE_CLI_BIN_DIR = args.remoteCliBridgeEnv.binDir
    merged.ORCA_RELAY_DIR = args.remoteCliBridgeEnv.relayDir
    merged.ORCA_RELAY_NODE_PATH = args.remoteCliBridgeEnv.nodePath
    merged.ORCA_RELAY_SOCKET_PATH = args.remoteCliBridgeEnv.sockPath
    if (args.remoteCliBridgeEnv.credentialFile) {
      merged.ORCA_RELAY_CREDENTIAL_FILE = args.remoteCliBridgeEnv.credentialFile
    }
  }
  // Why: match local/daemon precedence—managed defaults cannot restore explicitly removed values.
  for (const key of args.envToDelete ?? []) {
    delete merged[key]
  }
  seedPowerlevel10kWizardEnv(merged, { envToDelete: args.envToDelete })
  return merged
}
