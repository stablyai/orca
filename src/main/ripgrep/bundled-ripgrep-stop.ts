import { signalProcessTree } from '@orca/process-host/process-tree-termination'
import { killSpawnedRipgrepProcess } from '../../shared/ripgrep/ripgrep-process-availability'
import type { ChildProcess } from 'node:child_process'

const stoppingChildren = new WeakSet<ChildProcess>()

export function stopBundledRipgrep(child: ChildProcess, wsl = false): void {
  if (stoppingChildren.has(child)) {
    return
  }
  stoppingChildren.add(child)
  if (process.platform === 'win32' && wsl && child.pid !== undefined) {
    void signalProcessTree(child).catch(() => killSpawnedRipgrepProcess(child))
  } else {
    killSpawnedRipgrepProcess(child)
  }
}
