import { execFile, type ChildProcess } from 'node:child_process'

// Why: Windows commands may run through wrappers, so killing only the direct
// child can leave Git or an agent alive after cancellation.
export function terminateRelaySubprocessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) {
    return
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {
      // Best-effort; the child close listener owns completion.
    })
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Child may already have exited between the kill request and now.
  }
}
