import { resolve } from 'node:path'

export type HostExecCommand = { command: string; args: string[] }

// Why: execPath can be a Windows-style path even when this runs on a posix
// dev machine's test suite, so the executable name is split on both
// separators instead of relying on node:path's platform-specific basename.
function executableName(execPath: string): string {
  const segments = execPath.split(/[/\\]/)
  const fileName = segments.at(-1) ?? ''
  return fileName.replace(/\.exe$/i, '').toLowerCase()
}

// Why: the CLI has no Electron `app.isPackaged` signal, so packaging is
// inferred from the running binary's name — a packaged `orca`/`orca-dev`
// binary execs directly, while a dev (node) run needs the CLI entry script
// passed as an argument. This is a heuristic, not a reliable packaging
// check: see install-native-messaging-host.ts install handler notes.
export function resolveHostExecCommand(execPath: string, argv1: string): HostExecCommand {
  if (executableName(execPath).startsWith('orca')) {
    return { command: execPath, args: [] }
  }
  return { command: execPath, args: [resolve(argv1)] }
}
