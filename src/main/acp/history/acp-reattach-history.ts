/** Treat all reattach traffic as history, even without provider replay marks. */
export function asReattachHistory(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return params
  }
  const meta = '_meta' in params ? params._meta : undefined
  const marked = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta : {}
  return { ...params, _meta: { ...marked, isReplay: true } }
}
