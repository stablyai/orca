import type {
  DaemonLaunchNote,
  DaemonLaunchNoteChange
} from '../protocol/daemon-launch-note-protocol'

/** Main's live launch here, so a reattach after a main restart can re-arm it.
 * Why no output scan: a finish while main is down is caught by reattach's foreground check. */
export class SessionLaunchNote {
  current: DaemonLaunchNote | null = null
  /** Main saw the launch finish; its agent no longer names what runs here. */
  retired = false

  change(change: DaemonLaunchNoteChange): void {
    if ('retire' in change) {
      if (change.retire === this.current?.launchToken) {
        this.current = null
        this.retired = true
      }
      return
    }
    this.current = change.arm
    this.retired = false
  }
}
