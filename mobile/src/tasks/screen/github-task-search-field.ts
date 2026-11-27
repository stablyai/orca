// A qualifier such as `is:closed` or `label:bug` makes the typed text a whole query of its own.
const QUALIFIER = /(^|\s)-?[a-z][a-z-]*:/i

/** What the search field shows: the words typed on top of the preset, never the preset itself. */
export function githubSearchFieldText(query: string, presetQuery: string): string {
  if (query.trim() === presetQuery.trim()) {
    return ''
  }
  return query.startsWith(`${presetQuery} `) ? query.slice(presetQuery.length + 1) : query
}

/** The query a field edit stands for: plain words narrow the preset, qualifiers replace it. */
export function githubQueryFromSearchField(text: string, presetQuery: string): string {
  if (text.trim() === '') {
    return presetQuery
  }
  return QUALIFIER.test(text) ? text : `${presetQuery} ${text}`
}
