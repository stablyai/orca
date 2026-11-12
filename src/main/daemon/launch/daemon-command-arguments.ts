export type ParsedDaemonArgs = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
  entryPath?: string
  appVersion?: string
  spawnerExecPath?: string
  /** GUI-spawned daemons only — headless serve/SSH daemons must survive session loss. */
  loginSessionWatch?: boolean
  freshDaemonScope?: boolean
  logFilePath?: string
  /** Host-local terminal history root this daemon owns; never a client host's path. */
  historyRoot?: string
}

export function parseArgs(argv: string[]): ParsedDaemonArgs {
  let socketPath = ''
  let tokenPath = ''
  let logFilePath = ''
  let pidPath = ''
  let launchNonce = ''
  let entryPath = ''
  let appVersion = ''
  let spawnerExecPath = ''
  let loginSessionWatch = false
  let freshDaemonScope = false
  let historyRoot = ''

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket' && argv[i + 1]) {
      socketPath = argv[i + 1]
      i++
    } else if (argv[i] === '--token' && argv[i + 1]) {
      tokenPath = argv[i + 1]
      i++
    } else if (argv[i] === '--log-file' && argv[i + 1]) {
      logFilePath = argv[i + 1]
      i++
    } else if (argv[i] === '--pid-record' && argv[i + 1]) {
      pidPath = argv[i + 1]
      i++
    } else if (argv[i] === '--launch-nonce' && argv[i + 1]) {
      launchNonce = argv[i + 1]
      i++
    } else if (argv[i] === '--entry-path' && argv[i + 1]) {
      entryPath = argv[i + 1]
      i++
    } else if (argv[i] === '--app-version' && argv[i + 1]) {
      appVersion = argv[i + 1]
      i++
    } else if (argv[i] === '--spawner-exec-path' && argv[i + 1]) {
      spawnerExecPath = argv[i + 1]
      i++
    } else if (argv[i] === '--history-root' && argv[i + 1]) {
      historyRoot = argv[i + 1]
      i++
    } else if (argv[i] === '--login-session-watch') {
      loginSessionWatch = true
    } else if (argv[i] === '--fresh-daemon-scope') {
      freshDaemonScope = true
    }
  }

  if (!socketPath || !tokenPath) {
    throw new Error('Usage: daemon-entry --socket <path> --token <path> [--log-file <path>]')
  }

  if ((pidPath && !launchNonce) || (!pidPath && launchNonce)) {
    throw new Error('Daemon PID record path and launch nonce must be provided together')
  }

  return {
    socketPath,
    tokenPath,
    ...(pidPath ? { pidPath, launchNonce } : {}),
    ...(entryPath ? { entryPath } : {}),
    ...(appVersion ? { appVersion } : {}),
    ...(spawnerExecPath ? { spawnerExecPath } : {}),
    ...(loginSessionWatch ? { loginSessionWatch } : {}),
    ...(freshDaemonScope ? { freshDaemonScope } : {}),
    ...(logFilePath ? { logFilePath } : {}),
    ...(historyRoot ? { historyRoot } : {})
  }
}
