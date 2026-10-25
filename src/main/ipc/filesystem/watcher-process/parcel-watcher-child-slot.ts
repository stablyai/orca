import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { removeWatcherCanaryDirectory } from '../../parcel-watcher-canary-directory'

export class WatcherChildSlot {
  child: ChildProcessHandle | null = null
  terminating: ChildProcessHandle | null = null
  canaryDir: string | null = null

  removeCanary(): void {
    this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
  }

  beginTermination(proc: ChildProcessHandle): void {
    this.terminating = proc
    this.removeCanary()
  }
}
