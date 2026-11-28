export function drainDevProcessGroup(pid, graceMs = 5000) {
  if (!pid || process.platform === 'win32') {
    return Promise.resolve()
  }
  const signal = (value) => {
    try {
      process.kill(-pid, value)
      return true
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error
      }
      return false
    }
  }
  if (!signal('SIGTERM')) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      clearInterval(probe)
      signal('SIGKILL')
      resolve()
    }, graceMs)
    const probe = setInterval(() => {
      if (!signal(0)) {
        clearInterval(probe)
        clearTimeout(deadline)
        resolve()
      }
    }, 100)
  })
}
