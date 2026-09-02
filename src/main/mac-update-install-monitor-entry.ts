import { runMacUpdateInstallMonitor } from './mac-update-install-monitor'

const [, , attemptPath, attemptId] = process.argv

if (!attemptPath || !attemptId) {
  console.error('Usage: mac-update-install-monitor-entry <attempt-path> <attempt-id>')
  process.exitCode = 64
} else {
  void runMacUpdateInstallMonitor({ attemptPath, attemptId }).then(
    () => {
      process.exitCode = 0
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  )
}
