/**
 * The single value of a route param expo-router may hand back repeated.
 *
 * A repeated query key (`?name=a&name=b`) comes back as an array, and a bare read puts that array
 * straight into a route template, where `String(['a','b'])` is `a,b` and `encodeURIComponent` makes
 * it the one segment `a%2Cb` — which the bridge's segment rule accepts, so the shell opens a page
 * for a host nobody has.
 *
 * Here rather than beside the source-control screen state, where it grew: every caller is a route
 * file under `app/h/`, and the import dragged that tree's git-status module into the closure of any
 * route that reads a param.
 */
export function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}
