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
      const pathValue = merged[pathKey] ?? ''
      merged[pathKey] = pathValue.split(pathDelimiter).includes(args.remoteCliBridgeEnv.binDir)
        ? pathValue
        : pathValue
          ? `${args.remoteCliBridgeEnv.binDir}${pathDelimiter}${pathValue}`
          : args.remoteCliBridgeEnv.binDir
    }
    merged.ORCA_REMOTE_CLI_BIN_DIR = args.remoteCliBridgeEnv.binDir
    merged.ORCA_RELAY_DIR = args.remoteCliBridgeEnv.relayDir
    merged.ORCA_RELAY_NODE_PATH = args.remoteCliBridgeEnv.nodePath
    merged.ORCA_RELAY_SOCKET_PATH = args.remoteCliBridgeEnv.sockPath
    if (args.remoteCliBridgeEnv.credentialFile) {
      merged.ORCA_RELAY_CREDENTIAL_FILE = args.remoteCliBridgeEnv.credentialFile
    }
    // Why: CLIs that honor $BROWSER (gh, git credential helpers) then ask the desktop that owns
    // this SSH session to open the page, after its owner approves. A user's own BROWSER wins.
    if (pathDelimiter === ':' && merged.BROWSER === undefined) {
      merged.BROWSER = `${quotePosixShellWord(`${args.remoteCliBridgeEnv.binDir}/orca`)} open-url --url %s`
    }
  }
  // Why: match local/daemon precedence—managed defaults cannot restore explicitly removed values.
  for (const key of args.envToDelete ?? []) {
    delete merged[key]
  }
  seedPowerlevel10kWizardEnv(merged, { envToDelete: args.envToDelete })
  return merged
}

// Why: $BROWSER is run through a shell by the tools that honor it, so a bin dir with spaces or
// quotes must stay one word.
function quotePosixShellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
