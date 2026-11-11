import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, join } from 'node:path'
import { spawnProcess } from '@orca/process-host'

export function spawnMenuBarChild(
  spawn = spawnProcess,
  qa = false,
  executable?: string
): ChildProcessWithoutNullStreams {
  return spawn({
    program:
      executable ??
      join(
        dirname(process.execPath),
        '..',
        'Resources',
        'Orca Menu Bar.app',
        'Contents',
        'MacOS',
        'orca-menu-bar'
      ),
    args: qa ? ['--qa'] : [],
    stdio: 'pipe'
  })
}

// The owned handle protects against PID reuse; SIGSTOP cannot defeat intentional retirement.
export function killMenuBarChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return
  }
  try {
    if (!child.kill('SIGKILL')) {
      console.warn('[menu-bar] helper termination not delivered')
    }
  } catch (error) {
    console.warn('[menu-bar] helper termination failed', error)
  }
}
