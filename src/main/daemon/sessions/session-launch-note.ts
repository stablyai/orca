import type {
  DaemonLaunchNote,
  DaemonLaunchNoteChange
} from '../protocol/daemon-launch-note-protocol'

/** Main's live launch here, so a reattach after a main restart can re-arm it.
 * Why no output scan: a finish while main is down is caught by reattach's foreground check. */
export class SessionLaunchNote {
  current: DaemonLaunchNote | null = null

  change(change: DaemonLaunchNoteChange): void {
    if ('retire' in change) {
      if (change.retire === this.current?.launchToken) {
        this.current = null
      }
      return
    }
    this.current = change.arm
  }
}
