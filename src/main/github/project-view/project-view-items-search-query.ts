// Why: empty filter must not use Projects `items(query:)` — GitHub's search
// index can return totalCount 0 for minutes after bulk populate (#12648).
export function projectViewItemsUseSearchQuery(query: string): boolean {
  return query.trim().length > 0
}
