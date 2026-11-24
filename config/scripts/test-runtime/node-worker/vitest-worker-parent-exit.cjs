// Pools stop workers by signal, so a dead parent means Vitest died; don't outlive it mid-file.
// Polls because Bun stops delivering Vitest's IPC messages once a 'disconnect' listener exists.
if (process.send) {
  // Bound before Vitest swaps process.exit for a throwing guard and tests mock process.kill.
  const exit = process.exit.bind(process)
  const kill = process.kill.bind(process)
  const parent = process.ppid
  const parentAlive = () => {
    // POSIX reparents orphans; Windows keeps the stale ppid, so probe it too.
    if (process.ppid !== parent) {
      return false
    }
    try {
      kill(parent, 0)
      return true
    } catch (error) {
      return error.code === 'EPERM'
    }
  }
  setInterval(() => {
    if (!parentAlive()) {
      exit(1)
    }
  }, 1000).unref()
}
