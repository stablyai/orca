// About one screenful: shorter lists are faster to scan than to search.
export const PICKER_SEARCH_MIN_ITEMS = 7

type SearchablePickerItem = { label: string; detail?: string }

/** Keeps items whose label or detail contains every typed word, in any order; label matches come first. */
export function filterPickerItems<T extends SearchablePickerItem>(
  items: readonly T[],
  query: string
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return [...items]
  }
  const containsEveryWord = (text: string) =>
    words.every((word) => text.toLowerCase().includes(word))
  const matches = items.filter((item) => containsEveryWord(`${item.label} ${item.detail ?? ''}`))
  return [
    ...matches.filter((item) => containsEveryWord(item.label)),
    ...matches.filter((item) => !containsEveryWord(item.label))
  ]
}
