/**
 * A representative build for a still-running daemon of each previous protocol.
 *
 * A daemon survives the app update that replaces it, so after an update every
 * pre-existing pane is served by a daemon built from OLD code. Reconstructing
 * that daemon by pointing the current `DaemonServer` at an old protocol number
 * only tests the current implementation wearing an old label — it cannot catch a
 * behavior change on the daemon side (#11789 shipped exactly that blind spot).
 * These refs let the cross-protocol reattach gate run the current adapter
 * against the real previous build.
 *
 * Each entry is the newest ref that shipped that protocol when one exists, so
 * within-protocol daemon fixes are included. Protocol 27 instead pins its last
 * main commit because it was superseded before release.
 */
export type LegacyDaemonRelease = {
  protocolVersion: number
  /** Newest release tag built at this protocol, or a commit when none shipped. */
  ref: string
}

// Why refs and not tags-only: protocols 6, 19 and 27 were superseded before a
// stable release cut, so their newest shipped artifact is an rc tag or — for 27,
// which never left main — the commit that carried it.
export const LEGACY_DAEMON_RELEASES: readonly LegacyDaemonRelease[] = [
  { protocolVersion: 1, ref: 'v1.3.16' },
  { protocolVersion: 2, ref: 'v1.3.19' },
  { protocolVersion: 3, ref: 'v1.3.21' },
  { protocolVersion: 4, ref: 'v1.3.47' },
  { protocolVersion: 5, ref: 'v1.4.2' },
  { protocolVersion: 6, ref: 'v1.4.2-rc.8' },
  { protocolVersion: 7, ref: 'v1.4.27' },
  { protocolVersion: 8, ref: 'v1.4.29' },
  { protocolVersion: 9, ref: 'v1.4.32' },
  { protocolVersion: 10, ref: 'v1.4.35' },
  { protocolVersion: 11, ref: 'v1.4.55' },
  { protocolVersion: 12, ref: 'v1.4.65' },
  { protocolVersion: 13, ref: 'v1.4.72' },
  { protocolVersion: 14, ref: 'v1.4.78' },
  { protocolVersion: 15, ref: 'v1.4.79' },
  { protocolVersion: 16, ref: 'v1.4.80' },
  { protocolVersion: 17, ref: 'v1.4.90' },
  { protocolVersion: 18, ref: 'v1.4.134' },
  { protocolVersion: 19, ref: 'v1.4.135-rc.2' },
  { protocolVersion: 20, ref: 'v1.4.135' },
  { protocolVersion: 21, ref: 'v1.4.141' },
  { protocolVersion: 22, ref: 'v1.4.145' },
  { protocolVersion: 23, ref: 'v1.4.146' },
  { protocolVersion: 24, ref: 'v1.4.149' },
  { protocolVersion: 25, ref: 'v1.4.150' },
  { protocolVersion: 26, ref: 'v1.4.155' },
  { protocolVersion: 27, ref: '7ab601487c2e4c05b7067a5157e395300a0bdc0c' },
  { protocolVersion: 28, ref: 'v1.4.159' },
  { protocolVersion: 29, ref: 'v1.4.161' },
  { protocolVersion: 30, ref: 'v1.4.167' }
]
