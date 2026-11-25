// Native routes all share one JS context, so a host list opened from here sees what this screen left for it.
export function useHostListInThisDocument(_hostId: string): boolean {
  return true
}
