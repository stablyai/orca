import type { ChildProcess } from 'node:child_process'
import { removeWatcherCanaryDirectory } from './parcel-watcher-canary-directory'

export class WatcherChildSlot {
  child: ChildProcess | null = null
  terminating: ChildProcess | null = null
  canaryDir: string | null = null

  removeCanary(): void {
    this.canaryDir = removeWatcherCanaryDirectory(this.canaryDir)
  }

  beginTermination(proc: ChildProcess): void {
    this.terminating = proc
    this.removeCanary()
  }
}
