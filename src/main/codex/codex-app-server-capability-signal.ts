// Why: only an argv parse failure that names app-server proves the RPC surface
// is absent; unrelated stderr must remain transient rather than poison the cache.
export function stderrIndicatesMissingAppServer(stderrTail: string): boolean {
  return /^(?=.*\bapp-server\b).*(?:unrecognized subcommand|unexpected argument|invalid subcommand)/im.test(
    stderrTail
  )
}
