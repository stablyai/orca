// A workflow run's `path` can be ref-qualified (".github/workflows/x.yml@main"). Accept the exact workflow file,
// bare or qualified only with main, the same rule release-mac-build.yml's admission guard applies in jq.
// Node builtins only (none needed), so any workflow-commit script can import it.
export function workflowRunPathMatches(path, expectedFile) {
  if (typeof path !== 'string' || typeof expectedFile !== 'string' || expectedFile === '') {
    return false
  }
  const parts = path.split('@')
  if (parts.length > 2 || parts[0] !== expectedFile) {
    return false
  }
  return parts.length === 1 || parts[1] === 'main' || parts[1] === 'refs/heads/main'
}
