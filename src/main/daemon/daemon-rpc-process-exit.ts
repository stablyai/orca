export type DaemonRpcShutdownMode = 'verified-stalled-owner'

export function exitDaemonAfterRpcShutdown(mode?: DaemonRpcShutdownMode): never {
  if (mode === 'verified-stalled-owner') {
    // process.exit joins the same native workers whose failed progress prompted this recovery.
    process.kill(process.pid, 'SIGKILL')
  }
  process.exit(0)
}
