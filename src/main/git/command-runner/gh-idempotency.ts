const NON_IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
// `gh <noun> <verb>` write subcommands; reads are absent on purpose so they keep retrying.
const NON_IDEMPOTENT_GH_VERBS = new Set([
  'create',
  'edit',
  'update',
  'delete',
  'close',
  'reopen',
  'merge',
  'comment',
  'review',
  'ready',
  'lock',
  'unlock',
  'pin',
  'unpin',
  'transfer',
  'develop'
])

export function argsLookIdempotent(args: string[]): boolean {
  let explicitMethodSeen = false
  let hasApiBodyField = false
  let hasGraphQlQuery = false
  const isGraphQlApi = args[0] === 'api' && args[1] === 'graphql'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-X' || a === '--method') {
      explicitMethodSeen = true
      const next = args[i + 1]
      if (typeof next === 'string' && NON_IDEMPOTENT_METHODS.has(next.toUpperCase())) {
        return false
      }
    }
    // Single-token form `--method=POST` (gh accepts this).
    if (a.startsWith('--method=')) {
      explicitMethodSeen = true
      const value = a.slice('--method='.length)
      if (NON_IDEMPOTENT_METHODS.has(value.toUpperCase())) {
        return false
      }
    }
    // `gh api` auto-POSTs when -f/-F/--field body fields are given without -X; track them.
    if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') {
      hasApiBodyField = true
    } else if (
      a.startsWith('-f=') ||
      a.startsWith('-F=') ||
      a.startsWith('--field=') ||
      a.startsWith('--raw-field=')
    ) {
      hasApiBodyField = true
    }
    // Detect GraphQL `query=mutation(…)` so endpoint writes also fail fast on transient errors.
    if (a.startsWith('query=')) {
      hasGraphQlQuery = true
      const trimmed = a.slice('query='.length).trimStart().toLowerCase()
      if (trimmed.startsWith('mutation')) {
        return false
      }
    }
  }
  // `gh api -f foo=bar` with no -X auto-POSTs → non-idempotent; GraphQL query bodies are the exception (still reads).
  if (
    args[0] === 'api' &&
    hasApiBodyField &&
    !explicitMethodSeen &&
    !(isGraphQlApi && hasGraphQlQuery)
  ) {
    return false
  }
  // `gh <noun> <verb>` writes (args[1]); `gh api` without -X defaults to idempotent GET, so it's excluded here.
  if (args.length >= 2 && args[0] !== 'api') {
    if (NON_IDEMPOTENT_GH_VERBS.has(args[1])) {
      return false
    }
  }
  return true
}
