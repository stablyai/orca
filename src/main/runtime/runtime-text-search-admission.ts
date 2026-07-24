export const RUNTIME_TEXT_SEARCH_MAX_ACTIVE = 16

export function assertRuntimeTextSearchAdmission(
  activeSearchKeys: ReadonlyMap<string, unknown>,
  requestedKey: string,
  maxActive = RUNTIME_TEXT_SEARCH_MAX_ACTIVE
): void {
  if (!activeSearchKeys.has(requestedKey) && activeSearchKeys.size >= maxActive) {
    throw new Error('Runtime text search is busy; retry after current searches finish.')
  }
}
