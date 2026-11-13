const STALE_HANDLE_SERVER_HINT =
  'Terminal handles belong to the Orca server that issued them. If this handle came from a paired server (for example `orca terminal list --environment <server>`), pass the same --environment <server> to this command.'

// One code covers a refused fresh start and a running terminal whose history read failed.
const TERMINAL_HISTORY_UNAVAILABLE_HINT =
  "The terminal host couldn't read or prepare this terminal's history. A running terminal keeps running: rerun the command to retry, or read its current screen with `orca terminal read --screen`. A new terminal refused this way never started; run the create command again."

/** Next steps for `orca terminal` failures whose error alone cannot say what to do. */
export function terminalCommandRecovery(
  code: string | undefined,
  context: { commandPath?: readonly string[]; remoteServerSelected?: boolean }
): { nextSteps: readonly string[] } | undefined {
  if (context.commandPath?.[0] !== 'terminal') {
    return undefined
  }
  // A remote handle sent locally looks stale rather than missing a flag.
  if (code === 'terminal_handle_stale' && context.remoteServerSelected === false) {
    return { nextSteps: [STALE_HANDLE_SERVER_HINT] }
  }
  if (code === 'terminal_history_unavailable') {
    return { nextSteps: [TERMINAL_HISTORY_UNAVAILABLE_HINT] }
  }
  return undefined
}
