import { seedPowerlevel10kWizardEnv } from '../pty/powerlevel10k-wizard-env'
import { resolveRemoteCliRuntime, type RemoteCliBridgeEnv } from './ssh-pty-provider-contract'

export function buildSshPtySpawnEnv(args: {
  env: Record<string, string> | undefined
  envToDelete?: readonly string[]
  remoteCliBridgeEnv?: RemoteCliBridgeEnv
}): Record<string, string> {
  const merged = { ...args.env }
  if (args.remoteCliBridgeEnv) {
    const bridge = args.remoteCliBridgeEnv
    const runtime = resolveRemoteCliRuntime(bridge)
    const pathDelimiter = bridge.pathDelimiter ?? ':'
    const pathKey = merged.PATH !== undefined ? 'PATH' : merged.Path !== undefined ? 'Path' : null
    if (pathKey) {
      const pathValue = merged[pathKey] ?? ''
      merged[pathKey] = pathValue.split(pathDelimiter).includes(bridge.binDir)
        ? pathValue
        : pathValue
          ? `${bridge.binDir}${pathDelimiter}${pathValue}`
          : bridge.binDir
    }
    merged.ORCA_REMOTE_CLI_BIN_DIR = bridge.binDir
    merged.ORCA_RELAY_DIR = bridge.relayDir
    // Emit the generic fields for modern deploy results. Legacy Node-only
    // bridge payloads keep their original environment shape.
    if (bridge.runtimePath || bridge.runtimeKind) {
      merged.ORCA_RELAY_RUNTIME_PATH = runtime.path
      merged.ORCA_RELAY_RUNTIME_KIND = runtime.kind
    }
    if (runtime.kind === 'node') {
      // Keep the old variable for clients/relays that predate runtime metadata.
      merged.ORCA_RELAY_NODE_PATH = runtime.path
    } else {
      // A Bun runtime must not be advertised through the Node-only variable.
      delete merged.ORCA_RELAY_NODE_PATH
    }
    merged.ORCA_RELAY_SOCKET_PATH = bridge.sockPath
    if (bridge.credentialFile) {
      merged.ORCA_RELAY_CREDENTIAL_FILE = bridge.credentialFile
    }
  }
  // Why: match local/daemon precedence—managed defaults cannot restore explicitly removed values.
  for (const key of args.envToDelete ?? []) {
    delete merged[key]
  }
  seedPowerlevel10kWizardEnv(merged, { envToDelete: args.envToDelete })
  return merged
}
