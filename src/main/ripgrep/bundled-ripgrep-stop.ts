import { signalProcessTree } from '@orca/process-host/process-tree-termination'
import { killSpawnedRipgrepProcess } from '../../shared/ripgrep-process-availability'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'

const stoppingChildren = new WeakSet<ChildProcessHandle>()

export function stopBundledRipgrep(child: ChildProcessHandle, wsl = false): void {
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
