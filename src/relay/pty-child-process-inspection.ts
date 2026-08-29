import { runProcess } from '../shared/child-process/run-process'

export async function inspectProcessChildren(pid: number): Promise<{
  hasChildProcesses: boolean
  unavailable?: true
}> {
  try {
    const result = await runProcess({
      program: 'pgrep',
      args: ['-P', String(pid)],
      timeoutMs: 3000
    })
    if (result.code === 0 && result.stdout.trim().length > 0) {
      return { hasChildProcesses: true }
    }
    if (result.code === 1 && !result.timedOut) {
      return { hasChildProcesses: false }
    }
    return { hasChildProcesses: false, unavailable: true }
  } catch {
    return { hasChildProcesses: false, unavailable: true }
  }
}
