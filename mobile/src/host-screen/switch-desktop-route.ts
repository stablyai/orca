// The native sheet the host page opens on phones, where the page cannot read the paired-desktop list.
export function switchDesktopRoute(hostId: string): `/switch-desktop?from=${string}` {
  return `/switch-desktop?from=${encodeURIComponent(hostId)}`
}
