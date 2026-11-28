import { RuntimeClientError } from '../runtime/connection/types'

// A forwarded shell's files are on another machine, out of this process's reach.
export function refuseForwardedShell(): void {
  if (process.env.ORCA_CLI_CWD) {
    throw new RuntimeClientError(
      'invalid_environment',
      "This shell forwards orca to another machine, whose files this command can't reach. Run it from a shell on the machine that has them."
    )
  }
}
