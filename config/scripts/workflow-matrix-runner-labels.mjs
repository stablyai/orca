const MATRIX_RUNNER = /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*(?:\|\|\s*'([^'$]*)'\s*)?\}\}$/

/**
 * The runner labels a job's `runs-on` can take, read from its own literal matrix.
 *
 * Resolves only `${{ matrix.<key> }}` and `${{ matrix.<key> || '<label>' }}` against a matrix
 * written out in the file. Anything else -- another expression, a computed matrix, a value that
 * is itself an expression, a leg with no value and no fallback -- comes back unchanged, so a
 * caller treating expressions as unknown still fails closed.
 */
export function workflowMatrixRunnerLabels(job) {
  const runsOn = job?.['runs-on']
  const match = typeof runsOn === 'string' ? MATRIX_RUNNER.exec(runsOn.trim()) : null
  const matrix = job?.strategy?.matrix
  if (!match || !matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    return runsOn
  }
  const [, key, fallback] = match
  const axis = matrix[key]
  const include = matrix.include ?? []
  if ((axis !== undefined && !Array.isArray(axis)) || !Array.isArray(include)) {
    return runsOn
  }
  const otherAxes = Object.keys(matrix).some(
    (name) => name !== key && name !== 'include' && name !== 'exclude'
  )
  const labels = [
    ...(axis ?? []),
    ...include.map((leg) => leg?.[key] ?? fallback),
    // Legs built from other axes alone take the fallback.
    ...(axis === undefined && otherAxes ? [fallback] : [])
  ]
  const resolved = labels.every((label) => typeof label === 'string' && !label.includes('${{'))
  return resolved && labels.length > 0 ? [...new Set(labels)] : runsOn
}
