// Only argv errors naming app-server prove it absent; unrelated stderr must not poison the cache.
export function stderrIndicatesMissingAppServer(stderrTail: string): boolean {
  return /^(?=.*\bapp-server\b).*(?:unrecognized subcommand|unexpected argument|invalid subcommand)/im.test(
    stderrTail
  )
}
