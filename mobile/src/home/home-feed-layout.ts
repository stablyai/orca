import type { CloudEnrollment } from '../cloud/cloud-device-identity'

export type HomeFeedLayout = 'loading' | 'pair-desktop' | 'feed'

/**
 * The pairing empty state is only for a phone with nothing to show. A phone enrolled in Orca Cloud
 * keeps its Cloud section with no desktop paired (unpaired later, or lost): the workspaces are
 * reachable from the phone alone.
 */
export function homeFeedLayout(args: {
  hostCatalogLoaded: boolean
  hostCount: number
  /** `undefined` while the keychain read is in flight. */
  enrollment: CloudEnrollment | null | undefined
}): HomeFeedLayout {
  if (!args.hostCatalogLoaded) {
    return 'loading'
  }
  if (args.hostCount > 0) {
    return 'feed'
  }
  // Wait for the enrollment read rather than flash the pairing screen at an enrolled phone.
  if (args.enrollment === undefined) {
    return 'loading'
  }
  return args.enrollment ? 'feed' : 'pair-desktop'
}
