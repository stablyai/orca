// Native app owns socket’s binary frame path and needs no negotiation; web sibling must check older shell encoder support.
export function useBrowserBinaryScreencastGrant(): boolean {
  return true
}
