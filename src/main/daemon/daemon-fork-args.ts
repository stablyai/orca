import { runsOnDisposableProfile } from '../startup/disposable-profile-teardown'

/** The argv a daemon fork is launched with.
 *
 *  Extracted from the fork call so the one decision that matters here can be
 *  tested against the real production builder rather than asserted about a
 *  helper nothing calls: a daemon born to a THROWAWAY state root must be told
 *  which process owns it, so it can retire when that process dies. The candidate
 *  runtimes in the incident were never told, so nineteen daemons outlived their
 *  owners — and their state roots — with every supervised session still running.
 */
export type DaemonForkArgsInput = {
  socketPath: string
  tokenPath: string
  pidPath: string
  launchNonce: string
  entryPath: string
  appVersion: string
  spawnerExecPath: string
  macosLoginSessionWatch: boolean
  logArgs: readonly string[]
  ownerPid: number
  /** Seam for tests; production reads the real environment. */
  disposableProfile?: boolean
}

export function buildDaemonForkArgs(input: DaemonForkArgsInput): string[] {
  const disposable = input.disposableProfile ?? runsOnDisposableProfile()
  return [
    '--socket',
    input.socketPath,
    '--token',
    input.tokenPath,
    '--pid-record',
    input.pidPath,
    '--launch-nonce',
    input.launchNonce,
    '--entry-path',
    input.entryPath,
    '--app-version',
    input.appVersion,
    '--spawner-exec-path',
    input.spawnerExecPath,
    ...(input.macosLoginSessionWatch ? ['--login-session-watch'] : []),
    // A throwaway state root has nothing to reattach to, so the daemon must die
    // with the runtime that owns it — including when that runtime is SIGKILLed
    // and never runs a quit path at all.
    ...(disposable ? ['--retire-with-owner', String(input.ownerPid)] : []),
    ...input.logArgs
  ]
}
