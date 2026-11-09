// Use the first repeated Expo query value; array coercion would encode a,b as one valid but nonexistent host segment. Keep this free of screen/git-status imports.
export function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}
