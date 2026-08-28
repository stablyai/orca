/** The daemon entrypoint's argv contract.
 *
 *  Split from the entrypoint so the parser — which decides ownership, retirement
 *  and logging for the whole process — is readable and testable apart from the
 *  lifecycle it configures. */

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
  /** Set only for a throwaway state root: retire when this owner pid is gone.
   *  A disposable profile has nothing to reattach to, so surviving its owner
   *  leaves an unreachable daemon holding live sessions. */
  retireWithOwnerPid?: number
  retireWithOwnerStartedAtMs?: number
  /** Optional — absent for adopted old daemons and tests, which log nothing. */
  logFilePath?: string
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
  let retireWithOwnerPid = 0
  let retireWithOwnerStartedAtMs = 0

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
    } else if (argv[i] === '--login-session-watch') {
      loginSessionWatch = true
    } else if (argv[i] === '--retire-with-owner' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10)
      // A non-positive or unparsable owner pid would retire on the first probe,
      // so an unusable value is simply no watch rather than an instant suicide.
      retireWithOwnerPid = Number.isInteger(parsed) && parsed > 1 ? parsed : 0
      i++
    } else if (argv[i] === '--retire-with-owner-started-at' && argv[i + 1]) {
      const parsed = Number(argv[i + 1])
      retireWithOwnerStartedAtMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
      i++
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
    ...(retireWithOwnerPid && retireWithOwnerStartedAtMs
      ? { retireWithOwnerPid, retireWithOwnerStartedAtMs }
      : {}),
    ...(logFilePath ? { logFilePath } : {})
  }
}
