export function isProcessRunning(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only ESRCH proves absence; EPERM indicates a live PID under another uid.
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}
