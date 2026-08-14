export function isServeProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only ESRCH proves the recorded process is gone; every other error stays fail-closed.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
