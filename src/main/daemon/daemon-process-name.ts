import { writeFileSync } from 'node:fs'

export function setDaemonProcessName(): void {
  if (process.platform !== 'linux') {
    return
  }
  try {
    // process.title overwrites argv, which daemon adoption and recovery use as identity evidence.
    writeFileSync('/proc/self/comm', 'orca-agents')
  } catch {
    // Naming must not prevent terminals starting when procfs is unavailable or read-only.
  }
}
