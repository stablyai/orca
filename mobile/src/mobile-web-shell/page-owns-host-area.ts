// Native has no init; the web sibling reads the page’s ownership fact.
export function usePageOwnsHostArea(): boolean {
  return false
}
