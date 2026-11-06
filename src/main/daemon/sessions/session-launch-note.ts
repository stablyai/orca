import {
  createOsc133CommandFinishedScanner,
  type Osc133CommandFinishedScanner
} from '../../../shared/terminal/output/terminal-osc133-command-finished'
import type {
  DaemonLaunchNote,
  DaemonLaunchNoteChange
} from '../protocol/daemon-launch-note-protocol'

/** Main's live launch here; retired on command-finished too, since it can finish while main is down. */
export class SessionLaunchNote {
  current: DaemonLaunchNote | null = null
  private retirement: Osc133CommandFinishedScanner | null = null

  scan(data: string): void {
    this.retirement?.scan(data)
  }

  change(change: DaemonLaunchNoteChange): void {
    const token = this.current?.launchToken
    if ('retire' in change) {
      if (change.retire === token) {
        this.current = null
        this.retirement = null
      }
      return
    }
    // Re-arming the same launch keeps the scanner, whose carry may hold a split marker.
    const note = change.arm
    if (note.launchToken !== token) {
      this.current = note
      this.retirement = createOsc133CommandFinishedScanner(() =>
        this.change({ retire: note.launchToken })
      )
    }
  }
}
