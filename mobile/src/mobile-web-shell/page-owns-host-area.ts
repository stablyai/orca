/** Natively there is no `init`: the page's own sidebar rule lives in the web sibling. */
export function usePageOwnsHostArea(): boolean {
  return false
}
