import { resolve } from 'node:path'

export type HostExecCommand = { command: string; args: string[] }

// Why: dev (execPath = node) and packaged (execPath = the Electron binary,
// launched with ELECTRON_RUN_AS_NODE=1 by the launcher script) both run the
// CLI entry script directly, so no packaging heuristic is needed here. A
// prior name-based heuristic ("orca*" execs directly) misidentified the
// packaged binary — .../MacOS/Orca — and dropped the CLI entry arg entirely,
// which made the launcher start the Orca GUI instead of the host process.
export function resolveHostExecCommand(execPath: string, argv1: string): HostExecCommand {
  return { command: execPath, args: [resolve(argv1)] }
}
