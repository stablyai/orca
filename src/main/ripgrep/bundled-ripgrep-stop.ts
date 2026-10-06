import { signalProcessTree } from '../../shared/child-process/process-tree-termination'
import { killSpawnedRipgrepProcess } from '../../shared/ripgrep-process-availability'
import type { ChildProcessHandle } from '../../shared/child-process/process-spec'

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
