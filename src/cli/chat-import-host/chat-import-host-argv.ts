// Why: Chrome launches the native-messaging host with the extension origin
// (chrome-extension://<id>/) and, on Windows, --parent-window=<handle>
// appended as positional argv — the CLI's normal parser mistakes the origin
// for a subcommand and rejects the unknown --parent-window flag, so the host
// run must be routed before ordinary command parsing. `install` is the one
// real subcommand and must still go through normal parsing.
export function isChatImportHostRun(argv: string[]): boolean {
  return argv[0] === 'chat-import-host' && argv[1] !== 'install'
}
