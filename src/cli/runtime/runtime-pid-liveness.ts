export function isProcessRunning(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Why: only ESRCH proves the pid is gone. EPERM means it exists under another uid, and
    // reporting that as `stale_bootstrap` calls a live Orca dead.
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}
